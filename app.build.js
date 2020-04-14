({
    appDir: "static",
    baseUrl: ".",
    dir: "out/dist",
    generateSourceMaps: true,
    preserveLicenseComments: false,
    optimize: "uglify2",
    removeCombined: true,
    useStrict: true,
    mainConfigFile: "static/main.ts",
    skipDirOptimize: true,
    optimizeCss: "standard",
    paths: { "vs": "empty:" },
    modules: [
        {
            name: "main"
        }
    ]
})
