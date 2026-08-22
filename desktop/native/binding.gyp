{
  "targets": [
    {
      "target_name": "mimo_loopback",
      "sources": [ "src/loopback.cc" ],
      "include_dirs": [ "<!@(node -p \"require('node-addon-api').include_dir\")" ],
      "defines": [ "NAPI_DISABLE_CPP_EXCEPTIONS", "UNICODE", "_UNICODE" ],
      "conditions": [
        ["OS=='win'", {
          "libraries": [ "-lole32.lib", "-lmmdevapi.lib" ],
          "msvs_settings": {
            "VCCLCompilerTool": { "ExceptionHandling": 0, "AdditionalOptions": [ "/std:c++17" ] }
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
