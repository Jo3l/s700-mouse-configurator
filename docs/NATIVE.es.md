# Host nativo: el mismo configurador sin permisos de navegador

El configurador es una página que habla WebHID. Eso tiene dos pegas que no son
del proyecto:

1. El navegador pide permiso **por origen** para cada dispositivo, y en Linux el
   nodo `/dev/hidraw*` es de root, así que hace falta una regla udev igualmente.
2. Solo funciona en navegadores con WebHID (Chrome, Edge, Brave…), y desde
   `file://` ni eso.

`native/` es un binario pequeño (una ventana, sin instalador) que hace lo mismo
pero sin navegador de por medio: sirve la UI desde dentro de sí mismo en
`127.0.0.1`, la enseña en su propia ventana con el WebView del sistema — WebView2
en Windows, WebKitGTK en Linux — y habla el HID él mismo.

```
make native        # native/target/release/s700-host (~1.3 MB)
make native-run    # lo compila y abre la ventana

# En Linux, para compilar hacen falta las cabeceras de WebKitGTK una vez
# (para ejecutar, la librería .so):
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev
```

```
s700-host [--port N] [--no-open] [--browser] [--list]

  --port N    puerto local (por defecto 8760). Fíjalo: el navegador guarda los
              cambios por origen, así que cambiar de puerto es cambiar de
              almacenamiento.
  --no-open   no abrir nada
  --browser   abrir la UI como pestaña normal en el navegador por defecto, en
              vez de la ventana de aplicación
  --list      enumerar las interfaces del ratón y salir
```

## Las tres formas de usar el mismo proyecto

| | Permisos | Depende de | Tamaño |
|---|---|---|---|
| `make serve` + Chrome | diálogo WebHID + regla udev en Linux | un navegador con WebHID | 0 |
| `dist/S700-configurador.html` | igual (se abre como `file://`) | ídem | ~520 KB |
| `make native` | **nada en Windows**; udev en Linux | Windows: nada (WebView2 viene con Edge). Linux: `libwebkit2gtk-4.1-0` + `libgtk-3-0` | ~1.3 MB |

Las tres sirven la misma UI: `web/` no se duplica ni se adapta.

## Un solo fichero para Linux (AppImage)

```
make appimage      # dist/S700-configurator-x86_64.AppImage (~80 MB)
```

`native/build-appimage.sh` lo construye dentro de `ubuntu:22.04` y mete en el
paquete WebKitGTK, su *injected bundle*, la pila GTK/GLib y las librerías de X11
con `linuxdeploy`. Dos detalles son los que lo hacen funcionar:

- **WebKitGTK no tiene variable de relocalización**: el directorio de sus procesos
  auxiliares (`WebKitWebProcess`, `WebKitNetworkProcess`, `WebKitGPUProcess`) va
  como ruta absoluta compilada. El build la reescribe a `./usr/lib/webkit2gtk-4.1`
  (misma longitud, relleno con NUL) y `AppRun` arranca con el AppImage como
  directorio de trabajo, así que la ruta relativa resuelve dentro del paquete.
- **GL, fuentes y permisos siguen en el sistema**: un AppImage no debe llevar los
  drivers de GPU, así que `libGL`/`libEGL`/`libGLESv2` y las fuentes salen del
  escritorio (cualquiera las tiene). El kernel sigue necesitando la regla udev para
  `/dev/hidraw*`; el binario se ofrece a instalarla.

Verificado en un contenedor `ubuntu:22.04` pelado (sin WebKitGTK ni GTK) bajo Xvfb:
la ventana abre, la página se pinta y el host lista el ratón.

## Cómo encaja sin tocar la UI

`web/bridge.js` es un enchufe: si `window.__S700_API__` existe (sólo lo pone el
host al servir el HTML), define un `navigator.hid` compatible con WebHID que en
vez de hablar con el navegador hace `fetch` contra el proceso. `app.js`,
`g6.js`, `core.js` y `storage.js` no se enteran — siguen llamando
`sendFeatureReport(7, …)` como siempre.

```
UI (web/*.js)  →  navigator.hid  →  bridge.js  →  HTTP 127.0.0.1  →  hidraw / hid.dll
```

Sin `__S700_API__` el fichero no hace nada, así que también se puede cargar en
el navegador normal sin efecto ninguno.

Rutas del host: `GET /api/devices`, `GET /api/state`, `POST /api/open`,
`POST /api/send`, `POST /api/recv` (siempre falla: el firmware no contesta a
GetFeature, `docs/PROTOCOL.md` §4).

## Permisos

**Windows**: nada. El proceso abre el dispositivo como cualquier otro fichero;
si falla suele ser porque la herramienta del fabricante o su bandeja lo tienen
abierto en exclusiva.

**Linux**: el kernel expone `/dev/hidrawN` como `0600 root:root`. Ni Chrome ni
este binario pueden escribir sin una regla; el binario **no** se salta eso
(sería un agujero, no una mejora). Lo que sí hace es ofrecerse a instalar la regla
por ti, una vez, con el diálogo de contraseña normal del escritorio:

* **desde la interfaz**: la pestaña *Debug* detecta que el nodo no se puede abrir y
  muestra **Install udev rule**. El binario pide la contraseña con `pkexec` y escribe
  la regla; a partir de ahí todo corre como tu usuario, Chrome incluido.
* **desde una terminal**: `./s700-host --install-rule` (lo mismo, sin ventana).
* **a mano**, si prefieres ver qué toca:

```
sudo cp native/99-s700-hid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# y reconectar el ratón (o reiniciar la sesión) para que logind aplique el ACL
```

El estado que hay detrás de ese botón es `GET /api/permissions`
(`needed`, `root`, `ruleInstalled`, `node`, `writable`), y `POST /api/install-rule`
hace la elevación y devuelve su salida.

**No ejecutes el servidor como root.** `sudo ./s700-host` "funciona" y no necesita
regla, pero deja un servidor HTTP local con capacidad de escribir en un dispositivo
corriendo como root: un agujero mucho mayor que una regla udev atada a un VID:PID.
La regla es un permiso puntual, por dispositivo y por sesión; root es para siempre y
para todo.

En una máquina sin sesión de escritorio (SSH, sin `logind`), `uaccess` no te da el
nodo: la regla también pone `MODE="0660" GROUP="input"`, así que añádete a `input`
(`sudo usermod -aG input $USER` y vuelve a entrar).

```
$ ./s700-host --list
/dev/hidraw1	30fa:1540	S700 Gaming Mouse
```

La enumeración no necesita permisos: se lee `/sys/class/hidraw/*` y se queda con
las interfaces cuyo descriptor declara el *vendor page* `0xFF00` (la de
configuración; la de ratón normal no lo declara). Por eso el diálogo de WebHID
enseñaba dos entradas con el mismo VID:PID y aquí sale sólo la buena.

## Compilar

**Linux** (lo que hay probado): `make native`, necesita solo `cargo`. No usa
crates, así que compila sin red (`--offline`).

**Windows**: backends escritos en `native/src/windows.rs` (`hid.dll` +
`cfgmgr32`), pero **no compilados ni probados todavía** — esta máquina es Linux
y no tiene toolchain de Windows. Para sacar el `.exe`:

```
rustup target add x86_64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc     # en Windows, o
rustup target add x86_64-pc-windows-gnu                    # en Linux con mingw-w64
cargo build --release --target x86_64-pc-windows-gnu
```

Es el mismo `main.rs` y el mismo protocolo HTTP; lo único distinto es cómo se
abre el dispositivo (`CreateFileW` + `HidD_SetFeature`).

## Qué está verificado y qué no

Probado aquí, con el ratón conectado a esta máquina:

- compila y arranca; `--list` encuentra `/dev/hidraw1 30fa:1540 S700 Gaming Mouse`
  filtrando la interfaz correcta entre dos con el mismo VID:PID;
- sirve la UI entera y el HTML sale con el enchufe inyectado;
- `/api/devices`, `/api/state` y los errores responden lo que toca;
- en Chrome, la página cargada desde el host tiene `navigator.hid.__native`,
  Connect enumera y devuelve el error real de permisos del nodo (`0600 root:root`)
  con la instrucción de la regla udev;
- `node tools/test_bridge.mjs` cubre el enchufe (15 checks): inerte sin host,
  `getDevices`/`open`/`sendFeatureReport` con el cuerpo HTTP correcto, y los
  errores del host propagados.

Sin probar todavía:

- **la escritura real** en el ratón desde el binario: este usuario no tiene
  permiso sobre `/dev/hidraw1` (0600 root) y no hay root en la máquina. Es el
  único tramo que queda: instalar la regla y pulsar Apply.
- **Windows**: compila en el CI (MSVC, WebView2) pero nunca se ha ejecutado: ni la
ventana ni la escritura HID están verificadas ahí.

## Por qué un webview del sistema y no Electron

La ventana es `wry` sobre `tao`: WebView2 (Chromium) en Windows, WebKitGTK en
Linux. Ninguno de los dos implementa WebHID, y por eso existe el puente HTTP: la
página habla con este proceso por `fetch`, así que al motor solo le toca pintar
HTML. De ahí que la ventana salga barata:

- nada de Electron: ~90–100 MB por plataforma, y en Linux seguiría necesitando la
  regla udev;
- tampoco Tauri: los mismos motores más un marco de configuración y plugins que
  este proyecto no usa, y ya es un solo binario con `web/` dentro;
- lo que cuesta la decisión: el binario de Linux enlaza `libwebkit2gtk-4.1` y
  `libgtk-3` en tiempo de ejecución (Windows no necesita nada: WebView2 viene con
  Edge). Si el WebView no se puede crear, el host cae a una ventana de aplicación
  de Edge/Chrome, `--browser` abre una pestaña normal y `--no-open` sigue sirviendo
  sin ventana.
