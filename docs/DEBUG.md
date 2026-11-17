# Depurar la sesión con el ratón a distancia

Andamio desechable que sirve la web y, a la vez, deja ver desde fuera (curl) todo
lo que hace la pestaña: tramas HID de ida y vuelta, clics, memoria leída, errores.
Sirve para diagnosticar el ratón real cuando la persona que lo tiene delante no
puede copiar la consola del navegador.

```bash
make debug        # http en :8099 y https en :8443 (reenvía al 8099)
```

Abrir el configurador con `?debug=1`:

```
http://<ip>:8099/web/index.html?debug=1
https://<ip>:8443/web/index.html?debug=1        (certificado autofirmado)
https://<host>/proxy/8099/web/index.html?debug=1  (si hay un proxy delante)
```

Sin `?debug=1` la página es la de siempre y no habla con nadie: `web/debug.js` no
viaja en `dist/S700-configurador.html` y ninguna etiqueta lo carga — lo inyecta
`tools/debugd.py` al servir la página (como `__debug.js`).

La página se parte en cuatro pestañas: **Configurator** (perfiles, botones con
*Aplicar al ratón* abajo, DPI), **Macros** (editor de macros guardadas en el
navegador), **Backup** (exportar/importar el fichero y lo que hay guardado en el
navegador) y **Debug** (diagnóstico del dispositivo, volcado de
memoria, tráfico HID y el *delay* entre bloques). Todo lo que sirve para mirar por
dentro vive en Debug: un fallo de conexión cambia de pestaña solo, y `?debug=1` o
`#debug` la abren de entrada (el hash sobrevive a la recarga; `#macros` y
`#backup` también valen).

## Leer la sesión

```bash
curl -s localhost:8099/debug/log.txt?n=200     # trazas legibles (+12.345 out 18 05 …)
curl -s localhost:8099/debug/log.txt?grep=err  # sólo errores
curl -s localhost:8099/debug/summary           # contadores, estados, memoria analizada
curl -s localhost:8099/debug/state             # última foto: memoria, config, lastVerify
curl -s localhost:8099/debug/mem               # volcado de la memoria leída
curl -s localhost:8099/debug/hid?n=40&dir=in   # últimas tramas de respuesta
```

## Mandarle órdenes a la página

```bash
curl -X POST -d 'action=read'    localhost:8099/debug/cmd
curl -X POST -d 'action=apply'   localhost:8099/debug/cmd
curl -X POST -H 'Content-Type: application/json' \
     -d '{"action":"eval","args":{"code":"return s.state.ready"}}' localhost:8099/debug/cmd
curl -s localhost:8099/debug/cmds              # pendientes y resultados
```

Acciones: `read`, `apply`, `connect`, `connectAll`, `backup`, `click`, `pause`,
`edits`, `clearEdits`, `mem`, `eval`, `reload`. `connect` no puede funcionar
remotamente: elegir el dispositivo exige un gesto del usuario.

## Qué mirar primero

| síntoma | dónde |
|---|---|
| «Failed to open the device» | `log.txt`: el sistema no cede el hidraw (Linux: `/dev/hidrawN` es `root:root 0600`; Windows: el programa del fabricante lo tiene abierto) |
| lee todo ceros | `summary.mem.looks_empty` y `hid.err`; subir el *delay* antes de releer |
| aplica pero no cambia nada | `summary.mem` (¿se escribió en el bloque del perfil activo?), `lastVerify.diffs` |
| cambia ahora y vuelve tras desconectar | escribir solo los bloques cambiados no basta: sospechosos `0x006E` (tabla de punteros) y la suma de comprobación |

## Habitat del ratón sin navegador (root)

El nodo `/dev/hidrawN` es `root:root 0600`, así que desde aquí se habla con el
ratón dentro de un contenedor, sin sudo:

```bash
docker run --rm --device /dev/hidraw1 -v "$PWD":/work -w /work g6re:local \
  python3 tools/probe/hidraw_probe.py /dev/hidraw1
```

Sólo hace `GET`/`SET` de informes feature: no confirma bloques, no escribe nada.
