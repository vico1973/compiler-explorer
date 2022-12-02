import re
from pathlib import Path

import_re = re.compile(r'^(import\s.*\sfrom )\'(\..*)\'(.*)')


def update(file_path: Path):
    output = []
    print(f"processing {file_path}")
    is_ts = file_path.suffix == ".ts"
    with file_path.open("r") as f:
        for line in f:
            if match := import_re.match(line):
                path = file_path.parent / match.group(2)
                if path.is_dir():
                    path = path / "index"
                if not path.is_file():
                    for extension in (".ts", ".js"):
                        found = path.with_suffix(path.suffix + extension)
                        if found.is_file():
                            break
                    else:
                        raise RuntimeError(f"No file {path}")
                    if extension == ".js" or not is_ts:
                        found = found.relative_to(file_path.parent)
                        line = f'{match.group(1)}\'./{found}\'{match.group(3)}\n'
            output.append(line)
    with file_path.open("w") as f:
        f.write("".join(output))


def main():
    base = Path(".")
    update(base / "app.js")
    for path in Path("lib").rglob("*.[tj]s"):
        update(path)


if __name__ == '__main__':
    main()
