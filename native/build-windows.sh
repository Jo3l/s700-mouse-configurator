#!/usr/bin/env bash
# The .exe can no longer be built from Linux.
#
# Since the window is a system WebView, the Windows binary links
# WebView2 (webview2-com), which only ships import libraries for MSVC:
# the x86_64-pc-windows-gnu target (mingw-w64) cannot link them. That is why the
# .exe comes from a windows-latest runner in CI (.github/workflows/release.yml).
#
# On a Windows machine with Visual Studio Build Tools:
#
#   cargo build --release --manifest-path native/Cargo.toml
#   -> native\target\release\s700-host.exe
#
# and the WebView2 runtime comes with Edge: there is nothing to install.
set -euo pipefail
echo "The Windows .exe needs MSVC (WebView2): build it on Windows or let the CI" >&2
echo "do it when a tag is published. See .github/workflows/release.yml." >&2
exit 1
