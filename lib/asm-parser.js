// Copyright (c) 2015, Compiler Explorer Authors
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
//     * Redistributions of source code must retain the above copyright notice,
//       this list of conditions and the following disclaimer.
//     * Redistributions in binary form must reproduce the above copyright
//       notice, this list of conditions and the following disclaimer in the
//       documentation and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
// AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
// IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
// ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
// LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
// CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
// SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
// INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
// CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
// ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
// POSSIBILITY OF SUCH DAMAGE.

import _ from 'underscore';

import { AsmRegex } from './asmregex';
import * as utils from './utils';

const stdInLooking = /<stdin>|^-$|example\.[^/]+$|<source>/;
const sourceTag = /^\s*\.loc\s+(\d+)\s+(\d+)\s+(.*)/;
const sourceD2Tag = /^\s*\.d2line\s+(\d+),?\s*(\d*).*/;
const source6502Dbg = /^\s*\.dbg\s+line,\s*"([^"]+)",\s*(\d+)/;
const source6502DbgEnd = /^\s*\.dbg\s+line[^,]/;
const sourceStab = /^\s*\.stabn\s+(\d+),0,(\d+),.*/;
const closeBrace = /}/;
const endBlock = /\.(cfi_endproc|data|text|section)/;
const startAppBlock = /\s*#APP.*/;
const endAppBlock = /\s*#NO_APP.*/;
const startAsmNesting = /\s*# Begin ASM.*/;
const endAsmNesting = /\s*# End ASM.*/;
const indentedLabelDef = /^\s*([$.A-Z_a-z][\w$.]*):/;
const cudaBeginDef = /\.(entry|func)\s+(?:\([^)]*\)\s*)?([$.A-Z_a-z][\w$.]*)\($/;
const cudaEndDef = /^\s*\)\s*$/;
// Lines matching the following pattern are considered comments:
// - starts with '#', '@', '//' or a single ';' (non repeated)
// - starts with ';;' and has non-whitespace before end of line
const commentOnly = /^\s*(((#|@|\/\/).*)|(\/\*.*\*\/)|(;\s*)|(;[^;].*)|(;;.*\S.*))$/;
const commentOnlyNvcc = /^\s*(((#|;|\/\/).*)|(\/\*.*\*\/))$/;

function fixLabelIndentation(line) {
    const match = line.match(indentedLabelDef);
    if (match) {
        return line.replace(/^\s+/, '');
    } else {
        return line;
    }
}

class ParseState {
    constructor(regexes, files, labelsUsed) {
        this.regexes = regexes;
        this.files = files;
        this.labelsUsed = labelsUsed;
        this.source = null;
        this.prevLabel = null;
        this.lastOwnSource = null;
        this.inNvccDef = false;
        this.inNvccCode = false;
        this.inCustomAssembly = 0;
        this.mayRemovePreviousLabel = true;
        this.keepInlineCode = false;
        this.labelDefinitions = {};
        this.asm = [];
    }

    clearSource() {
        this.source = null;
    }

    setSource(file, line, maybeColumn) {
        this.source = {
            file: !stdInLooking.test(file) ? file : null,
            line,
            ...(!isNaN(maybeColumn) && maybeColumn !== 0 ? {column: maybeColumn} : {}),
        };
    }

    clearPreviousLabel() {
        this.prevLabel = null;
    }

    setPreviousLabel(label) {
        this.prevLabel = label;
    }

    findLabelDef(line) {
        let match = line.match(this.regexes.labelDef) || line.match(this.regexes.assignmentDef);
        if (!match) {
            match = line.match(cudaBeginDef);
            if (match) {
                this.inNvccDef = true;
                this.inNvccCode = true;
            }
        }
        if (match)
            return match[1];
        return null;
    }

    handleCustomAssembly(line) {
        if (startAppBlock.test(line) || startAsmNesting.test(line)) {
            this.inCustomAssembly++;
        } else if (endAppBlock.test(line) || endAsmNesting.test(line)) {
            this.inCustomAssembly--;
        }
        if (this.inCustomAssembly > 0)
            return fixLabelIndentation(line);
        return line;
    }

    handleSource(line) {
        let match = line.match(sourceTag);
        if (match) {
            const file = this.files[parseInt(match[1])];
            const sourceLine = parseInt(match[2]);
            if (file) {
                this.setSource(file, sourceLine, parseInt(match[3]));
            } else {
                this.clearSource();
            }
        } else {
            match = line.match(sourceD2Tag);
            if (match) {
                this.setSource(null, parseInt(match[1]));
            }
        }
    }

    handleStabs(line) {
        const match = line.match(sourceStab);
        if (!match) return;
        // cf http://www.math.utah.edu/docs/info/stabs_11.html#SEC48
        switch (parseInt(match[1])) {
            case 68:
                this.setSource(null, parseInt(match[2]));
                break;
            case 132:
            case 100:
                this.clearSource();
                this.clearPreviousLabel();
                break;
        }
    }

    handle6502(line) {
        const match = line.match(source6502Dbg);
        if (match) {
            const file = match[1];
            const sourceLine = parseInt(match[2]);
            this.setSource(file, sourceLine);
        } else if (source6502DbgEnd.test(line)) {
            this.clearSource();
        }
    }

    handleEndBlock(line) {
        if (this.source && this.source.file === null) {
            this.lastOwnSource = this.source;
        }

        if (endBlock.test(line) || (this.inNvccCode && closeBrace.test(line))) {
            this.clearSource();
            this.clearPreviousLabel();
            this.lastOwnSource = null;
        }
    }

    handleLibraryCode() {
        // TODO untangle this.
        if (!(!this.lastOwnSource && this.source && this.source.file !== null)) {
            this.mayRemovePreviousLabel = true;
            return true;
        } else {
            if (this.mayRemovePreviousLabel && this.asm.length > 0) {
                const lastLine = this.asm[this.asm.length - 1];
                const labelDef = lastLine.text
                    ? lastLine.text.match(this.regexes.labelDef) : null;

                if (labelDef) {
                    this.asm.pop();
                    this.keepInlineCode = false;
                    delete this.labelDefinitions[labelDef[1]];
                } else {
                    this.keepInlineCode = true;
                }
                this.mayRemovePreviousLabel = false;
            }

            return this.keepInlineCode;
        }
    }

    handleCommentFilter(line) {
        return !(this.inNvccCode ? commentOnlyNvcc : commentOnly).test(line);
    }

    handleEmpty(line) {
        if (line.trim() === '') {
            const lastBlank = this.asm.length === 0 || this.asm[this.asm.length - 1].text === '';
            if (!lastBlank)
                this.asm.push({text: '', source: null, labels: []});
            return false;
        }
        return true;
    }

    handleLabelDefinition(line, filterLabels) {
        const labelDef = this.findLabelDef(line);
        if (labelDef) {
            this.wasLabelDef = true;
            // It's a label definition.
            if (this.labelsUsed[labelDef] === undefined) {
                // It's an unused label.
                if (filterLabels) {
                    return false;
                }
            } else {
                // A used label.
                this.setPreviousLabel(labelDef);
                this.labelDefinitions[labelDef] = this.asm.length + 1;
            }
        } else {
            this.wasLabelDef = false;
        }
        return true;
    }

    handleDirectives(line) {
        // Check for directives only if it wasn't a label; the regexp would
        // otherwise misinterpret labels as directives.
        if (this.wasLabelDef)
            return true;

        // If we're defining something in nvcc; then don't filter the params that look like directives.
        if (this.inNvccDef)
            return true;

        if (this.regexes.dataDefn.test(line) && this.prevLabel) {
            // We're defining data that's being used somewhere.
        } else {
            // .inst generates an opcode, so does not count as a directive
            if (this.regexes.directive.test(line) && !this.regexes.instOpcodeRe.test(line)) {
                return false;
            }
        }

        return true;
    }

    handleEndOfNvccDef(line) {
        if (this.inNvccDef) {
            if (cudaEndDef.test(line))
                this.inNvccDef = false;
        }
    }
}

export class AsmParser extends AsmRegex {
    constructor(compilerProps) {
        super();

        this.labelFindNonMips = /[.A-Z_a-z][\w$.]*/g;
        // MIPS labels can start with a $ sign, but other assemblers use $ to mean literal.
        this.labelFindMips = /[$.A-Z_a-z][\w$.]*/g;
        this.mipsLabelDefinition = /^\$[\w$.]+:/;
        this.dataDefn = /^\s*\.(string|asciz|ascii|[1248]?byte|short|x?word|long|quad|value|zero)/;
        this.fileFind = /^\s*\.file\s+(\d+)\s+"([^"]+)"(\s+"([^"]+)")?.*/;
        // Opcode expression here matches LLVM-style opcodes of the form `%blah = opcode`
        this.hasOpcodeRe = /^\s*(%[$.A-Z_a-z][\w$.]*\s*=\s*)?[A-Za-z]/;
        this.instructionRe = /^\s*[A-Za-z]+/;
        this.identifierFindRe = /[$.@A-Z_a-z][\dA-z]*/g;
        this.hasNvccOpcodeRe = /^\s*[@A-Za-z|]/;
        this.definesFunction = /^\s*\.(type.*,\s*[#%@]function|proc\s+[.A-Z_a-z][\w$.]*:.*)$/;
        this.definesGlobal = /^\s*\.(?:globa?l|GLB|export)\s*([.A-Z_a-z][\w$.]*)/;
        this.definesWeak = /^\s*\.(?:weakext|weak)\s*([.A-Z_a-z][\w$.]*)/;
        this.assignmentDef = /^\s*([$.A-Z_a-z][\w$.]*)\s*=/;
        this.directive = /^\s*\..*$/;

        this.binaryHideFuncRe = null;
        this.maxAsmLines = 5000;
        if (compilerProps) {
            const binaryHideFuncReValue = compilerProps('binaryHideFuncRe');
            if (binaryHideFuncReValue) {
                this.binaryHideFuncRe = new RegExp(binaryHideFuncReValue);
            }

            this.maxAsmLines = compilerProps('maxLinesOfAsm', this.maxAsmLines);
        }

        this.asmOpcodeRe = /^\s*([\da-f]+):\s*(([\da-f]{2} ?)+)\s*(.*)/;
        this.lineRe = /^(\/[^:]+):(\d+).*/;
        this.labelRe = /^([\da-f]+)\s+<([^>]+)>:$/;
        this.destRe = /\s([\da-f]+)\s+<([^+>]+)(\+0x[\da-f]+)?>$/;
        this.commentRe = /[#;]/;
        this.instOpcodeRe = /(\.inst\.?\w?)\s*(.*)/;
    }

    hasOpcode(line, inNvccCode) {
        // Remove any leading label definition...
        const match = line.match(this.labelDef);
        if (match) {
            line = line.substr(match[0].length);
        }
        // Strip any comments
        line = line.split(this.commentRe, 1)[0];
        // .inst generates an opcode, so also counts
        if (this.instOpcodeRe.test(line)) return true;
        // Detect assignment, that's not an opcode...
        if (this.assignmentDef.test(line)) return false;
        if (inNvccCode) {
            return !!this.hasNvccOpcodeRe.test(line);
        }
        return !!this.hasOpcodeRe.test(line);
    }

    labelFindFor(asmLines) {
        const isMips = _.any(asmLines, line => !!this.mipsLabelDefinition.test(line));
        return isMips ? this.labelFindMips : this.labelFindNonMips;
    }

    findUsedLabels(asmLines, filterDirectives) {
        const labelsUsed = {};
        const weakUsages = {};
        const labelFind = this.labelFindFor(asmLines);
        // The current label set is the set of labels all pointing at the current code, so:
        // foo:
        // bar:
        //    add r0, r0, #1
        // in this case [foo, bar] would be the label set for the add instruction.
        let currentLabelSet = [];
        let inLabelGroup = false;
        const parseState = new ParseState(this, null, null);

        // Scan through looking for definite label usages (ones used by opcodes),
        // and ones that are weakly used: that is, their use is conditional on another label.
        // For example:
        // .foo: .string "moo"
        // .baz: .quad .foo
        //       mov eax, .baz
        // In this case, the '.baz' is used by an opcode, and so is strongly used.
        // The '.foo' is weakly used by .baz.
        for (let line of asmLines) {
            line = parseState.handleCustomAssembly(line);

            let match = line.match(this.labelDef);
            if (match) {
                if (inLabelGroup)
                    currentLabelSet.push(match[1]);
                else
                    currentLabelSet = [match[1]];
                inLabelGroup = true;
            } else {
                inLabelGroup = false;
            }
            match = line.match(this.definesGlobal);
            if (!match)
                match = line.match(this.definesWeak);
            if (!match)
                match = line.match(cudaBeginDef);
            if (match) {
                labelsUsed[match[1]] = true;
            }

            const definesFunction = line.match(this.definesFunction);
            if (!definesFunction && (!line || line[0] === '.')) continue;

            match = line.match(labelFind);
            if (!match) continue;

            if (!filterDirectives || this.hasOpcode(line, false) || definesFunction) {
                // Only count a label as used if it's used by an opcode, or else we're not filtering directives.
                for (const label of match) labelsUsed[label] = true;
            } else {
                // If we have a current label, then any subsequent opcode or data definition's labels are referred to
                // weakly by that label.
                const isDataDefinition = !!this.dataDefn.test(line);
                const isOpcode = this.hasOpcode(line, false);
                if (isDataDefinition || isOpcode) {
                    for (const currentLabel of currentLabelSet) {
                        if (!weakUsages[currentLabel]) weakUsages[currentLabel] = [];
                        for (const label of match) weakUsages[currentLabel].push(label);
                    }
                }
            }
        }

        // Now follow the chains of used labels, marking any weak references they refer
        // to as also used. We iteratively do this until either no new labels are found,
        // or we hit a limit (only here to prevent a pathological case from hanging).
        function markUsed(label) {
            labelsUsed[label] = true;
        }

        const MaxLabelIterations = 10;
        for (let iter = 0; iter < MaxLabelIterations; ++iter) {
            let toAdd = [];
            _.each(labelsUsed, (t, label) => { // jshint ignore:line
                _.each(weakUsages[label], nowused => {
                    if (labelsUsed[nowused]) return;
                    toAdd.push(nowused);
                });
            });
            if (!toAdd) break;
            _.each(toAdd, markUsed);
        }
        return labelsUsed;
    }

    parseFiles(asmLines) {
        const files = {};
        for (const line of asmLines) {
            const match = line.match(this.fileFind);
            if (match) {
                const lineNum = parseInt(match[1]);
                if (match[4]) {
                    // Clang-style file directive '.file X "dir" "filename"'
                    files[lineNum] = match[2] + '/' + match[4];
                } else {
                    files[lineNum] = match[2];
                }
            }
        }
        return files;
    }

    // Remove labels which do not have a definition.
    removeLabelsWithoutDefinition(asm, labelDefinitions) {
        _.each(asm, obj => {
            obj.labels = obj.labels.filter(label => labelDefinitions[label.name]);
        });
    }

    // Get labels which are used in the given line.
    getUsedLabelsInLine(line) {
        const labelsInLine = [];

        // Strip any comments
        const instruction = line.split(this.commentRe, 1)[0];

        // Remove the instruction.
        const params = instruction.replace(this.instructionRe, '');

        const removedCol = instruction.length - params.length + 1;
        params.replace(this.identifierFindRe, (label, index) => {
            const startCol = removedCol + index;
            labelsInLine.push({
                name: label,
                range: {
                    startCol: startCol,
                    endCol: startCol + label.length,
                },
            });
        });

        return labelsInLine;
    }

    processAsm(asmResult, filters) {
        if (filters.binary) return this.processBinaryAsm(asmResult, filters);

        const startTime = process.hrtime.bigint();

        if (filters.commentOnly) {
            // Remove any block comments that start and end on a line if we're removing comment-only lines.
            const blockComments = /^[\t ]*\/\*(\*(?!\/)|[^*])*\*\/\s*/gm;
            asmResult = asmResult.replace(blockComments, '');
        }

        let asmLines = utils.splitLines(asmResult);
        const startingLineCount = asmLines.length;
        if (filters.preProcessLines !== undefined) {
            asmLines = filters.preProcessLines(asmLines);
        }

        const parseState = new ParseState(
            this,
            this.parseFiles(asmLines),
            this.findUsedLabels(asmLines, filters.directives),
        );

        for (let line of asmLines) {
            if (!parseState.handleEmpty(line))
                continue;
            line = parseState.handleCustomAssembly(line);
            // TODO combine some of these? Or pipeline in a principled way.
            parseState.handleSource(line);
            parseState.handleStabs(line);
            parseState.handle6502(line);
            parseState.handleEndBlock(line);

            if (filters.libraryCode && !parseState.handleLibraryCode())
                continue;

            if (filters.commentOnly && !parseState.handleCommentFilter(line))
                continue;

            if (!parseState.handleLabelDefinition(line, filters.labels))
                continue;

            parseState.handleEndOfNvccDef(line);
            if (filters.directives && !parseState.handleDirectives(line)) {
                continue;
            }

            const text = AsmRegex.filterAsmLine(utils.expandTabs(line), filters);
            const labelsInLine = parseState.wasLabelDef ? [] : this.getUsedLabelsInLine(text);

            parseState.asm.push({
                text: text,
                source: this.hasOpcode(utils.expandTabs(line), parseState.inNvccCode) ? parseState.source : null,
                labels: labelsInLine,
            });
        }

        this.removeLabelsWithoutDefinition(parseState.asm, parseState.labelDefinitions);

        const endTime = process.hrtime.bigint();
        return {
            asm: parseState.asm,
            labelDefinitions: parseState.labelDefinitions,
            parsingTime: ((endTime - startTime) / BigInt(1000000)).toString(),
            filteredCount: startingLineCount - parseState.asm.length,
        };
    }

    isUserFunction(func) {
        if (this.binaryHideFuncRe === null) return true;

        return !this.binaryHideFuncRe.test(func);
    }

    processBinaryAsm(asmResult, filters) {
        const startTime = process.hrtime.bigint();
        const asm = [];
        const labelDefinitions = {};

        let asmLines = asmResult.split('\n');
        const startingLineCount = asmLines.length;
        let source = null;
        let func = null;
        let mayRemovePreviousLabel = true;

        // Handle "error" documents.
        if (asmLines.length === 1 && asmLines[0][0] === '<') {
            return {
                asm: [{text: asmLines[0], source: null}],
            };
        }

        if (filters.preProcessBinaryAsmLines !== undefined) {
            asmLines = filters.preProcessBinaryAsmLines(asmLines);
        }

        for (const line of asmLines) {
            const labelsInLine = [];

            if (asm.length >= this.maxAsmLines) {
                if (asm.length === this.maxAsmLines) {
                    asm.push({
                        text: '[truncated; too many lines]',
                        source: null,
                        labels: labelsInLine,
                    });
                }
                continue;
            }
            let match = line.match(this.lineRe);
            if (match) {
                source = {file: null, line: parseInt(match[2])};
                continue;
            }

            match = line.match(this.labelRe);
            if (match) {
                func = match[2];
                if (this.isUserFunction(func)) {
                    asm.push({
                        text: func + ':',
                        source: null,
                        labels: labelsInLine,
                    });
                    labelDefinitions[func] = asm.length;
                }
                continue;
            }

            if (!func || !this.isUserFunction(func)) continue;

            if (filters.libraryCode && source && source.file !== null) {
                if (mayRemovePreviousLabel && asm.length > 0) {
                    const lastLine = asm[asm.length - 1];
                    if (lastLine.text && this.labelDef.test(lastLine.text)) {
                        asm.pop();
                    }
                    mayRemovePreviousLabel = false;
                }
                continue;
            } else {
                mayRemovePreviousLabel = true;
            }

            match = line.match(this.asmOpcodeRe);
            if (match) {
                if (typeof match[5] !== 'undefined') match[2] = match[5].replace(/([\da-f]{2})/g, '$1 ').split(' ').reverse().join(' '); // For nvdisasm
                const address = parseInt(match[1], 16);
                const opcodes = match[2].split(' ').filter(x => !!x);
                const disassembly = ' ' + AsmRegex.filterAsmLine(match[4], filters);
                const destMatch = line.match(this.destRe);
                if (destMatch) {
                    const labelName = destMatch[2];
                    const startCol = disassembly.indexOf(labelName) + 1;
                    labelsInLine.push({
                        name: labelName,
                        range: {
                            startCol: startCol,
                            endCol: startCol + labelName.length,
                        },
                    });
                }
                asm.push({
                    opcodes: opcodes,
                    address: address,
                    text: disassembly,
                    source: source,
                    labels: labelsInLine,
                });
            }
        }

        this.removeLabelsWithoutDefinition(asm, labelDefinitions);

        const endTime = process.hrtime.bigint();

        return {
            asm: asm,
            labelDefinitions: labelDefinitions,
            parsingTime: ((endTime - startTime) / BigInt(1000000)).toString(),
            filteredCount: startingLineCount - asm.length,
        };
    }

    process(asm, filters) {
        return this.processAsm(asm, filters);
    }
}
