#!/usr/bin/env bash
# AppImage autocontenido del host nativo (Linux x86_64).
#
# El binario enlaza WebKitGTK y GTK, así que un AppImage "de verdad" tiene que
# llevar dentro esas librerías Y los procesos que WebKit lanza por su cuenta
# (WebKitWebProcess / WebKitNetworkProcess / WebKitGPUProcess + su injected
# bundle). Todo eso se hace en un contenedor Ubuntu 22.04 (glibc 2.35), que es
# también el suelo del AppImage: Debian 12+, Ubuntu 22.04+.
#
#   ./native/build-appimage.sh
#   -> dist/S700-configurator-x86_64.AppImage  (~90-150 MB)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(dirname "$here")"
img="${BUILD_IMAGE:-ubuntu:22.04}"

docker run --rm -v "$repo:/w" -w /w -e APPIMAGE_EXTRACT_AND_RUN=1 -e ARCH=x86_64 \
  "$img" bash -c '
set -e
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates build-essential pkg-config file patchelf python3 \
  libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libx11-dev \
  libwebkit2gtk-4.1-0 libgtk-3-0 libsoup-3.0-0 >/dev/null

# Rust reciente (wry 0.57 pide 1.85+)
if ! command -v cargo >/dev/null; then
  curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
  . "$HOME/.cargo/env"
fi
cargo build --release --manifest-path /w/native/Cargo.toml

# herramientas de empaquetado
cd /tmp
curl -sSL -o linuxdeploy https://github.com/linuxdeploy/linuxdeploy/releases/download/continuous/linuxdeploy-x86_64.AppImage
curl -sSL -o linuxdeploy-plugin-gtk.sh https://raw.githubusercontent.com/linuxdeploy/linuxdeploy-plugin-gtk/master/linuxdeploy-plugin-gtk.sh
curl -sSL -o appimagetool https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x linuxdeploy linuxdeploy-plugin-gtk.sh appimagetool

# AppDir: escritorio + icono + el binario
mkdir -p /tmp/AppDir/usr/share/applications /tmp/AppDir/usr/share/icons/hicolor/256x256/apps
cat > /tmp/s700.desktop <<EOF
[Desktop Entry]
Type=Application
Name=S700 configurator
Comment=Configurator for the HXSJ S700 «G6» gaming mouse
Exec=s700-host
Icon=s700
Terminal=false
Categories=Settings;HardwareSettings;
EOF
cp /w/native/s700.png /tmp/AppDir/usr/share/icons/hicolor/256x256/apps/s700.png

export PATH="/tmp:$PATH"
/tmp/linuxdeploy --appdir /tmp/AppDir \
  --executable /w/native/target/release/s700-host \
  --desktop-file /tmp/s700.desktop \
  --icon-file /w/native/s700.png \
  --plugin gtk 2>&1 | tail -15

# linuxdeploy deja fuera las librerías que considera "del sistema" (freetype,
# fontconfig, png…). Un escritorio las tiene, pero el AppImage se anuncia como
# autocontenido: se copian si faltan, que son ~2 MB.
for lib in libfreetype.so.6 libfontconfig.so.1 libpng16.so.16 libharfbuzz.so.0 \
           libgraphite2.so.3 libexpat.so.1 libbrotlidec.so.1 libbrotlicommon.so.1 \
           libX11.so.6 libX11-xcb.so.1 libXau.so.6 libXdmcp.so.6 libxcb.so.1 \
           libXext.so.6 libXrender.so.1 libXi.so.6 libXrandr.so.2 libXcursor.so.1 \
           libXfixes.so.3 libXinerama.so.1 libXcomposite.so.1 libXdamage.so.1 \
           libxkbcommon.so.0 libxkbcommon-x11.so.0 libwayland-client.so.0 \
           libwayland-cursor.so.0 libwayland-egl.so.1 libdrm.so.2 libgbm.so.1 \
           libepoxy.so.0 libstdc++.so.6 libgcc_s.so.1; do
  if [ ! -e "/tmp/AppDir/usr/lib/$lib" ]; then
    src="$(readlink -f "/usr/lib/x86_64-linux-gnu/$lib" 2>/dev/null || true)"
    if [ -f "$src" ]; then cp -a "$src" "/tmp/AppDir/usr/lib/$lib"; fi
  fi
done

# Cierre de dependencias: linuxdeploy deja fuera "lo del sistema" y cada
# escritorio es distinto, así que se recorre ldd de todo lo que hay en el AppDir
# y se copia lo que falte, salvo la libc y los drivers gráficos (esos mejor del
# sistema: son los que hablan con la GPU).
for round in 1 2 3 4; do
  for f in /tmp/AppDir/usr/bin/s700-host /tmp/AppDir/usr/lib/*.so*; do
    [ -f "$f" ] || continue
    ldd "$f" 2>/dev/null | tr -s " \t" "\n" | grep "^/" | while read -r lib; do
      base="$(basename "$lib")"
      case "$base" in
        libc.so.6|libm.so.6|libdl.so.2|libpthread.so.0|librt.so.1|libresolv.so.2|libutil.so.1|libnsl.so.1|ld-linux*) continue ;;
        libGL.so.1|libEGL.so.1|libGLX.so.0|libGLdispatch.so.0|libcuda.so.1|libnvidia*) continue ;;
      esac
      [ -e "/tmp/AppDir/usr/lib/$base" ] || cp -L "$lib" "/tmp/AppDir/usr/lib/$base"
    done
  done
done

# WebKit lanza sus procesos auxiliares desde su propio directorio
mkdir -p /tmp/AppDir/usr/lib/webkit2gtk-4.1
cp -a /usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/. /tmp/AppDir/usr/lib/webkit2gtk-4.1/
rm -f /tmp/AppDir/usr/lib/webkit2gtk-4.1/MiniBrowser

# WebKitGTK no tiene variable para la ruta de sus procesos: LIBEXECDIR va como
# cadena absoluta dentro de la librería. Se reapunta a una ruta relativa
# (misma longitud, relleno con NUL) y el AppRun arranca con el AppDir como
# directorio de trabajo, así que "./usr/lib/webkit2gtk-4.1/..." resuelve dentro
# del AppImage sin tocar el sistema.
python3 - <<"PY"
lib = "/tmp/AppDir/usr/lib/libwebkit2gtk-4.1.so.0"
data = open(lib, "rb").read()
for old, new in [
    (b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1/injected-bundle/", b"./usr/lib/webkit2gtk-4.1/injected-bundle/"),
    (b"/usr/lib/x86_64-linux-gnu/webkit2gtk-4.1", b"./usr/lib/webkit2gtk-4.1"),
]:
    assert len(new) <= len(old)
    n = data.count(old)
    data = data.replace(old, new + b"\x00" * (len(old) - len(new)))
    print(f"{n} x {old.decode()}")
open(lib, "wb").write(data)
PY

# AppRun propio: rutas relativas, sin tocar el sistema
rm -f /tmp/AppDir/AppRun
cat > /tmp/AppDir/AppRun <<"EOF"
#!/bin/sh
here="$(dirname "$(readlink -f "$0")")"
cd "$here" || exit 1
export LD_LIBRARY_PATH="$here/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export WEBKIT_EXEC_PATH="$here/usr/lib/webkit2gtk-4.1"
if [ -f "$here/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache" ]; then
  export GDK_PIXBUF_MODULE_FILE="$here/usr/lib/gdk-pixbuf-2.0/2.10.0/loaders.cache"
fi
exec "$here/usr/bin/s700-host" "$@"
EOF
chmod +x /tmp/AppDir/AppRun

mkdir -p /w/dist
/tmp/appimagetool /tmp/AppDir /w/dist/S700-configurator-x86_64.AppImage 2>&1 | tail -5
ls -la /w/dist/*.AppImage
'
# el contenedor compila como root: devolver el target al usuario
docker run --rm -v "$repo:/w" "$img" chown -R "$(id -u):$(id -g)" /w/native/target 2>/dev/null || true
ls -la "$repo/dist/S700-configurator-x86_64.AppImage"
