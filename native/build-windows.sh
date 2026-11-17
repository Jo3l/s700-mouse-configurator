#!/usr/bin/env bash
# Compila el .exe de Windows desde Linux, sin instalar nada en el sistema: usa
# un contenedor con rustup y mingw-w64.
#
#   ./native/build-windows.sh
#   -> native/target/x86_64-pc-windows-gnu/release/s700-host.exe
#
# En Windows nativo basta con:  cargo build --release --target x86_64-pc-windows-msvc
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
img="${RUST_IMAGE:-rust:1-slim-bookworm}"
echo "imagen $img · destino x86_64-pc-windows-gnu (mingw-w64)"
docker run --rm -v "$repo:/w" -w /w/native "$img" bash -c '
set -e
apt-get update -qq
apt-get install -y -qq gcc-mingw-w64-x86-64 >/dev/null
rustup target add x86_64-pc-windows-gnu >/dev/null
cargo build --release --offline --target x86_64-pc-windows-gnu
'
# el contenedor compila como root: devolver el target al usuario, que si no no
# puede ni borrarlo
docker run --rm -v "$repo:/w" "$img" chown -R "$(id -u):$(id -g)" /w/native/target 2>/dev/null || true
out="$here/target/x86_64-pc-windows-gnu/release/s700-host.exe"
ls -l "$out"
