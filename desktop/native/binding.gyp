{
  "targets": [
    {
      "target_name": "mimo_loopback",
      "sources": [ "src/loopback.cc" ],
      # .include devolve o caminho ABSOLUTO (entre aspas); include_dir é relativo
      # ao cwd e o MSBuild roda de native/build, onde esse relativo não existe
      "include_dirs": [ "<!@(node -p \"require('node-addon-api').include\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [ "-lole32.lib", "-lmmdevapi.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 0 }
          }
        }],
        ["OS!='win'", {
          # fora do Windows o addon não existe: o require é opcional no JS
          "sources": [],
          "type": "none"
        }]
      ]
    }
  ]
}
