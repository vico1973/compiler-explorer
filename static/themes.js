// Copyright (c) 2012-2017, Matt Godbolt & Rubén Rincón
//
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

define(function (require) {
    "use strict";
    var $ = require('jquery');
    var _ = require('underscore');
    var themes = {
        default: {
            path: "./themes/explorer-default.css",
            id: "default",
            name: "Default",
            monaco: "vs" // Optional field
        },
        dark: {
            path: "./themes/dark/theme-dark.css",
            id: "dark",
            name: "Dark",
            monaco: "vs-dark"
        }
        /* TODO: Work out a good high contrast style
        contrast: {
            path: "./themes/contrast/theme-contrast.css",
            id: "contrast",
            name: "High contrast",
            monaco: "hc-black"
        }*/
    };
    function Themer(eventHub) {
        this.currentTheme = null;
        this.eventHub = eventHub;
        this.root = root;

        function setTheme(theme) {
            $.get(require.toUrl(theme.path), function (thing) {
                $('#theme').html(thing);
                eventHub.emit('themeChange', theme);
            });
        }

        // Always insert default.
        setTheme(themes.default);

        this.eventHub.on('settingsChange', function (newSettings) {
            var newTheme = themes[newSettings.theme];
            if (!newTheme)
                return;
            if (!newTheme.monaco)
                newTheme.monaco = "vs";
            if (newTheme !== this.currentTheme) {
                setTheme(newTheme);
                this.currentTheme = newTheme;
            }
        }, this);

        this.eventHub.on('requestTheme', function () {
            this.eventHub.emit('themeChange', this.currentTheme);
        }, this);
    }

    return {
        themes: themes,
        Themer: Themer
    };
});
