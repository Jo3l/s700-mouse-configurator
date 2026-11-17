#!/usr/bin/env bash
# El .exe ya no se puede compilar desde Linux.
#
# Desde que la ventana es un WebView del sistema, el binario de Windows enlaza
# WebView2 (webview2-com), que sólo trae bibliotecas de importación para MSVC:
# el target x86_64-pc-windows-gnu (mingw-w64) no puede enlazarlas. Por eso el
# .exe sale de un runner windows-latest en CI (.github/workflows/release.yml).
#
# En una máquina Windows con Visual Studio Build Tools:
#
#   cargo build --release --manifest-path native/Cargo.toml
#   -> native\target\release\s700-host.exe
#
# y el runtime de WebView2 viene con Edge: no hay nada que instalar.
set -euo pipefail
echo "El .exe de Windows necesita MSVC (WebView2): compílalo en Windows o deja que" >&2
echo "lo haga el CI al publicar una etiqueta. Ver .github/workflows/release.yml." >&2
exit 1
