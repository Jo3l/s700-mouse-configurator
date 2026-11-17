# Protocolo del S700 (HXSJ) — notas de ingeniería inversa

Todo lo que hay aquí está **verificado** ejecutando el programa del fabricante
(`original/S700 Gaming Mouse.exe`) contra un ratón simulado, salvo lo que se marca
explícitamente como *inferido* o *sin confirmar*.

El método está en [`tools/`](../tools): el EXE corre bajo Wine y una DLL propia
(`tools/hid_shim.c`) suplanta `HidD_*` y `SetupDi*` para capturar cada informe HID.
Con `tools/probe/probe.sh` se lanza el programa, se pulsa OK y se vuelca el tráfico
a un log; `tools/probe/sweep.py` cambia un campo del `config.ini` cada vez y anota
qué bytes del ratón cambian.

---

## 1. Interfaz HID

El programa no usa ficheros para el ratón: abre la **colección vendor** y habla por
informes *feature*.

Descriptor real del ratón (leído con WebHID el 16/11/2026, VID:PID `30fa:1540`,
producto «USB GAMING MOUSE»):

| Colección | Informes |
|---|---|
| `UsagePage 0xFF00`, `Usage 0x01` | **input** 6 (datos del ratón), sin feature |
| `UsagePage 0xFF01`, `Usage 0x01` | **feature 7: 56 bits = 7 bytes** (configuración) |
| `UsagePage 0x0C` (consumidor), `Usage 0x01` | input 2 (multimedia) |

| Dato | Valor |
|---|---|
| Colección de configuración | `UsagePage 0xFF01`, `Usage 0x01` |
| Informe | *feature* **report ID 7, 7 bytes de datos** (8 con el ID) |
| VID/PID que acepta el programa | `0x30FA` con `0x1540` o `0x1E01` (compara `HIDD_ATTRIBUTES` y una lista de nombres de producto) |
| API usada | `HidD_SetFeature` / `HidD_GetFeature` en un handle `CreateFile(..., GENERIC_READ|GENERIC_WRITE)` |

> **Ojo con el tamaño.** El programa del fabricante pasa un búfer de 65 bytes y la
> pila HID lo recorta a 8 sin rechistar; WebHID (y `hidapi` en Windows) exigen el
> tamaño exacto que declara el descriptor, así que enviar 64 bytes de datos da
> `Failed to write the feature report`. La trama real son **7 bytes de datos**.

No usa `WriteFile`/`ReadFile`: sólo informes feature, lo que **hace viable WebHID**
en el navegador (`sendFeatureReport` / `receiveFeatureReport`).

## 2. Trama

```
byte 0   0x07            report ID (no viaja en el búfer de sendFeatureReport)
byte 1   0x18            constante en toda trama observada
byte 2   cmd             comando (ver tabla)
byte 3   índice          posición dentro de la ráfaga (0..n-1)
byte 4   addr_lo         dirección, byte bajo
byte 5   addr_hi         dirección, byte alto
byte 6   dato            byte de datos
byte 7   longitud-1      n-1 (0 cuando n = 1; 0 cuando no aplica)
```

| cmd | significado |
|---|---|
| `0x03` | escribir un byte (se acumula en el búfer del ratón) |
| `0x05` | leer un byte (la respuesta llega en el byte 6) |
| `0x09` | confirmar el bloque: escribe lo acumulado en `addr` |
| `0x00` | fin de transacción / no-op |
| `0x10` | fin de sesión (al cerrar) |

## 3. Escritura

Para cada bloque de 8 bytes (es lo que usa el fabricante; también usa bloques de 1 y 2):

```
-> 07 18 03 00 08 00 21 07   escribir 0x21 en 0x0008 (índice 0, longitud 8)
-> 07 18 03 01 08 00 22 07   índice 1 ...
   ... 8 tramas ...
-> 07 18 09 00 08 00 00 07   commit del bloque en 0x0008
-> 07 18 00 00 08 00 00 00   fin
```

Entre trama y trama el programa espera ~2 ms. El commit copia el búfer al
almacenamiento del ratón; la trama `cmd 0x09` lleva la **dirección inicial** y
`longitud-1`.

## 4. Lectura

```
-> 07 18 05 00 76 00 00 00   leer 1 byte en 0x0076
<- 07 18 05 00 76 00 XX 00   la respuesta repite cabecera y trae el dato en el byte 6
```

El programa del fabricante sólo lee **un byte** (dirección `0x0076`, al final de la
subida).

> **Probado en hardware (17/11/2026): la lectura no devuelve el protocolo.**
> `GetFeature(7)` en un `30FA:1540` («USB GAMING MOUSE», informe de 7 bytes) desde
> Chrome/Windows devuelve 8 bytes que empiezan por el *report id* y siguen con
> datos que cambian con el movimiento (`07 01 5e 09 03 00 27 90`), nunca `18 05 …`,
> con cualquier espera y con las variantes de 1 byte, ráfaga y comandos vecinos
> probadas. El `/dev/hidraw1` que aparece en la máquina de desarrollo **no es una
> segunda unidad**: es el ratón virtual que crea `tools/hid_shim.c` en el
> contenedor (`/sys/devices/virtual/misc/uhid`), y contesta con el `g_reply` del
> shim, no con firmware.
>
> Matriz de lo probado en el `30FA:1540` (Chrome/Windows, 17/11/2026):
>
> | Prueba | Resultado |
> |---|---|
> | `GetFeature(7)` en reposo, y tras leer `0x0001`, `0x0008`, `0x0076` | siempre el mismo bloque ajeno al protocolo (`07 xx 5e 09 03 00 27 90`) |
> | esperas de 2, 30, 150 y 300 ms | igual |
> | lecturas por ráfaga (índice 0..7, `len-1 = 7`) | igual |
> | comandos `0x00–0x0F`, `0x10–0x12` (sin `0x09`, que escribe) | igual, cambia sólo el primer byte del bloque |
> | informe de entrada 2 y 6 (`inputreport`) en reposo y tras cada petición | **ninguno** (no se recibe nada) |
> | `GetFeature` de otros report ids (0–6, 8, 15) | `NotAllowedError`: sólo existe el 7 |
>
> Conclusión: no hay canal de lectura. El firmware implementa la escritura y nada
> más, así que el configurador no lee (ni lo intenta).
>
> Mientras eso no diga otra cosa, el firmware implementa `SetFeature` pero no
> contesta a `GetFeature`, así que el
> configurador **no puede leer lo que el ratón tiene guardado**. Trabaja sobre la
> imagen que el propio fabricante escribe para su `config.ini` de fábrica
> (`web/default_image.js`, generada de `tools/probe/baseline.log` con
> `tools/make_default_image.py`) y la escribe igual que él. La lectura queda como
> sonda: si algún día una unidad contesta, `state.canRead` pasa a `true` y se
> vuelve a verificar lo escrito releyéndolo.
>
> Ojo al detalle de Windows: `receiveFeatureReport` devuelve el *report id* como
> primer byte, así que hay que quitarlo antes de interpretar la trama (si no,
> todo sale desfasado un byte).

### Escritura: la imagen completa o nada (confirmado en hardware, 17/11/2026)

Escribir sólo los bloques que cambian **no surte efecto**: el ratón acepta los
commits (no hay error) y sigue ejecutando la configuración anterior. Con la imagen
completa — los 108 bloques de `WRITE_BLOCKS`, en el mismo orden que usa el
fabricante, con la tabla de punteros de `0x006E` incluida — el cambio sí se aplica.
El configurador manda siempre la imagen entera por eso.

## 5. Mapa de memoria

| Rango | Contenido |
|---|---|
| `0x0001` | perfil activo: `0x03 \| (perfil << 5)` → 0x03, 0x23, 0x43, 0x63 |
| `0x0008–0x000F` | botones del **perfil 0** (8 ranuras) |
| `0x0010–0x0017` | DPI (nibbles en `0x15..0x17`), `0x14` = nivel DPI |
| `0x0018–0x001F` | `0x1A` tiempo de ráfaga, `0x1C` tipo de LED, `0x1E` tasa de sondeo USB |
| `0x0020–0x003F` | colores de LED por etapa/nivel, `0x3F` brillo (nibble alto) |
| `0x003B–0x003C` | botones 7 y 8 del **perfil 0** |
| `0x0044–0x004E` | botones del **perfil 1** |
| `0x0050–0x005A` | botones del **perfil 2** |
| `0x0060–0x006A` | botones del **perfil 3** |
| `0x006E–0x007F` | tabla de punteros a registros + suma de comprobación (cambia con las acciones) |
| `0x00A0–0x02CF` | registros de acciones avanzadas / macros (no descifrado) |
| `0x0400–0x04A7` | más registros y bloque de flags |
| `0x0080–0x009F` | **no** se escribe con la configuración por defecto (¿perfiles sin usar?) |

El programa **escribe siempre** `0x0001`, `0x006E` (2 bytes) y los 15 bloques de
`0x0008` a `0x007F`, más `0x00A0–0x02CF` y `0x0400–0x04A7`. Nunca escribe
`0x0080–0x009F` en el perfil 1.

### Botones (perfil 0 = el activo)

| Ranura | Dirección | `config.ini` |
|---|---|---|
| izquierdo | `0x08` | K0 |
| derecho | `0x0A` | K1 |
| central | `0x09` | K2 |
| adelante | `0x0C` | K3 |
| atrás | `0x0B` | K4 |
| botón 6 | `0x0D` | K5 |
| botón 7 | `0x3B` | K6 |
| botón 8 | `0x3C` | K7 |
| botón 9 | `0x0F` | K8 |
| botón 10 | `0x0E` | K9 |
| — | — | K10 no se escribe (no existe en este modelo) |

Perfiles 1–3 usan el mismo orden pero desplazado: `0x44`, `0x50`, `0x60` son la
ranura K0 de cada uno, con K6/K7 en `0x4D/0x4E`, `0x59/0x5A`, `0x69/0x6A`. La ranura
de K9 sólo aparece como byte simple en el perfil 3 (`0x66`); en los perfiles 1 y 2
la acción K9 por defecto es una función avanzada y se guarda como registro.

### Tabla de acciones (id de `config.ini` → código en el ratón)

| id | código | id | código | id | código |
|---|---|---|---|---|---|
| 1 | `0x21` | 8 | `0x23` | 15 | `0x35` |
| 2 | `0x22` | 9 | `0x24` | 16 | `0x2B` |
| 3 | `0x23` | 10 | `0x25` | 17 | `0x2C` |
| 4 | `0x24` | 11 | `0x26` | 18 | `0x34` |
| 5 | `0x25` | 12 | `0x27` | 19 | `0x37` |
| 6 | `0x26` | 13 | `0x28` | 20 | `0x38` |
| 7 | `0x22` | 14 | `0x29` | ≥21 | acción avanzada → registro |

Los identificadores 1–6 son los botones estándar (izquierdo, central, derecho,
atrás, adelante); 12 «mostrar escritorio», 14 «ráfaga», 15 «LED loop», 16/17 DPI
+/−, 19 «cambiar LED». Los códigos 7–11 repiten los de 2–6: el ratón no distingue
esas variantes del fabricante.

### DPI

Seis etapas en 3 bytes, **dos códigos de 4 bits por byte**, nibble alto = etapa par:

```
código(etapa) = (ajuste + 1) & 0xF        si ajuste <= 9
                (ajuste + 2) & 0xF        si ajuste >= 10
```

Comprobado etapa a etapa: `5→6`, `7→8`, `8→9`, `10→12`, `12→14`, `15→1`, `16→2`,
`22→8`. Con la configuración de fábrica (`DPI_SET0..5 = 5,7,10,15,16,22`) los bytes
`0x15..0x17` salen `68 C1 28`.

> **Aviso:** el contador se queda en 4 bits, así que ajustes distintos colapsan en el
> mismo código (7 y 22 dan `8`). El valor en dpi que enseña la herramienta del
> fabricante (1200, 1600, 2400, 6400, 7200, 12800 para esos ajustes) sale de su
> tabla, no del byte. La correspondencia **código → dpi real del sensor no está
> confirmada** y hay que medirla en el ratón.

### Otros campos verificados

| Dirección | Campo | Comprobación |
|---|---|---|
| `0x1E` | tasa de sondeo USB (índice) | `2→3` cambia el byte |
| `0x1C` | tipo de efecto LED | `9→10` cambia el byte |
| `0x3F` (nibble alto) | brillo LED | `0→1` pasa `0x00` a `0x10` |
| `0x1A` | tiempo de ráfaga | cambia con `FIRE_TIME`, se propaga a los registros |


## 5-bis. Acciones: no son sólo 20

La lista de funciones de la propia herramienta (`skins/INI_EN/skin_main_en.ini`,
sección `[FUN_STRING]`) tiene **41 entradas**. Medido con el arnés, se codifican de
tres maneras distintas:

| ids | codificación | dónde |
|---|---|---|
| 1–22 | **1 byte** en la dirección del botón | `0x21 … 0x3a` |
| 23–32 (multimedia) | byte `0x2f` + **registro** con el *usage* HID de consumidor | registro |
| 33–41 (atajos, macro, teclas) | byte `0x3e`/`0x3f` + **registro** con modificador + tecla | registro |

### Funciones con un solo byte (medidas una a una)

| id | función | código | id | función | código |
|---|---|---|---|---|---|
| 1 | Left Button | `0x21` | 12 | Show Desktop | `0x27` |
| 2 | Mid Button | `0x22` | 13 | Double click | `0x28` |
| 3 | Right Button | `0x23` | 14 | Autofire (ráfaga) | `0x29` |
| 4 | Backward | `0x24` | 15 | LED Loop | `0x35` |
| 5 | Forward | `0x25` | 16 | DPI + | `0x2b` |
| 6 | DPI Loop | `0x26` | 17 | DPI − | `0x2c` |
| 19 | Office | `0x37` | 18 | Fn function | `0x34` |
| 20 | Game I | `0x38` | 21 | Game II | `0x39` |
| 22 | Game III | `0x3a` | | | |

Los ids 7–11 (`Extend`, `Media`, `Macro`, `ShortCut`, `Mode`) son **categorías del
menú**, no funciones: al elegirlas la herramienta guarda la sub-función concreta.

### Teclas multimedia (byte `0x2f` + usage HID de consumidor)

Registro de 9 bytes a partir de `0x186`:

```
01 00 ff <usage_lo> <usage_hi> 90 04 00 8a
```

| id | función | usage | id | función | usage |
|---|---|---|---|---|---|
| 23 | Browser | `0x0223` | 28 | Previous | `0x00b6` |
| 24 | Player | `0x0183` | 29 | Next | `0x00b5` |
| 25 | Mail | `0x018a` | 30 | Mute | `0x00e2` |
| 26 | Vol + | `0x00e9` | 31 | Play/Pause | `0x00cd` |
| 27 | Vol − | `0x00ea` | 32 | Calculator | `0x0192` |

Son *consumer usages* estándar de la página `0x0C`, y el ratón **tiene** esa
colección (`input 2`), así que estas funciones las ejecuta el firmware: deberían
funcionar sin la aplicación del fabricante.

**Ranuras del perfil activo** (medidas botón a botón; siguen el orden físico, no el
de la lista):

| botón (índice) | dir. del byte | ranura del registro | botón (índice) | dir. | ranura |
|---|---|---|---|---|---|
| 0 | `0x08` | `0x0A0` | 5 | `0x0D` | `0x0D2` |
| 1 | `0x0A` | `0x0B4` | 6 | `0x3B` | `0x0FA` |
| 2 | `0x09` | `0x0AA` | 7 | `0x3C` | `0x104` |
| 3 | `0x0C` | `0x0C8` | 8 | `0x0F` | `0x0E6` |
| 4 | `0x0B` | `0x0BE` | 9 | `0x0E` | `0x0DC` |

Volver a una función normal equivale a escribir el código de 1 byte y poner a cero
los 9 bytes del registro. El configurador ya lo hace así.

> Sin resolver: al asignar multimedia a los botones 0 y 1 la herramienta escribe
> además un **segundo registro** de 9 bytes (`01 00 ff 00 00 00 00 00 0a`) en
> `0x02BC` y `0x02C6`; con los botones 2–9 no lo hace. No sabemos qué significa ni
> si el ratón lo necesita, así que no lo replicamos. Si una tecla multimedia no
> funciona en el hardware, ese es el primer candidato.

### Atajos, teclas y macros (byte `0x3e`/`0x3f` + registro)

Registro de 9 bytes, mismos campos pero con `0x187` como byte de modificador:

```
01 04 ff <tecla_lo> <tecla_hi> 90 04 00 8a
```

Ejemplo medido: id 33 `Copy` → `01 04 ff b7 00 …`.

Los ids 50, 51, 52, 53 y 259 que trae el `config.ini` de fábrica son acciones
personalizadas de este grupo. Sus registros son:

| id | registro |
|---|---|
| 50 | `01 8c ff 00 00 20 04 00 82` |
| 51 | `01 89 ff 00 00 00 04 00 84` |
| 52 | `01 8c ff 00 00 50 04 00 90` |
| 53 | `01 82 ff 00 00 80 04 00 8a` |
| 259 | `01 88 ff 00 00 90 04 00 0a` |

Los valores `0x89`, `0x8c`, `0x82`, `0x88`, `0x8a`, `0x84` encajan sospechosamente
con **máscaras de modificadores HID** (`0x01` Ctrl, `0x02` Shift, `0x04` Alt,
`0x08` Win, `0x80` «hay modificador»), así que los campos de tecla y modificador
están ahí aunque todavía no sepamos en qué orden. Eso implica que **asignar Shift
(o Ctrl+C) a un botón es representable**; falta confirmar el reparto exacto de
campos y quién ejecuta la tecla.

**Sin resolver:** de dónde salen exactamente la tecla y el modificador (la
herramienta tiene un diálogo «Please enter the key»), cómo se reparten los
registros cuando varios botones usan funciones avanzadas (la tabla de punteros de
`0x006E` cambia de base: `0x0490`, `0x04a8`, `0x0460`…) y si el ratón ejecuta esas
teclas él mismo.

> Dato importante: el descriptor del ratón **no tiene colección de teclado**
> (sólo ratón `0xFF00`, configuración `0xFF01` y consumidor `0x0C`), y el EXE del
> fabricante no importa `SendInput` ni `keybd_event`. O las teclas de este grupo
> las envía el firmware por un camino que no vemos, o dependen de que la
> aplicación esté abierta. Se comprueba en 2 minutos: asignar `Copy` a un botón,
> **cerrar del todo** la aplicación del fabricante y pulsar el botón en el
> Bloc de notas.

## 5-ter. Macros: sí se guardan en el ratón

Contra lo que parecía al principio, **el contenido de las macros se sube al ratón**
en cada Apply: el bloque `0x0400–0x04A7` del volcado contiene el flujo de pasos, y
coincide con lo que muestra el editor. `constMacro.dat` es sólo la copia del PC
(8 macros), la fuente desde la que se rellena ese bloque.

Asignando a mano (pestaña Macro → elegir macro → Insert → Apply) la macro
«first aid» (tecla `8`, 10 ms, tecla `8`, 20 ms) al botón 10, el fabricante escribió:

| byte | valor | significado |
|---|---|---|
| `0x0E` (botón 10) | `0x2D` | **acción = macro** (multimedia era `0x2F`, básica `0x21–0x3A`) |
| `0xDC` (su ranura) | `01 02 ff 00 00 00 04 00 0A 00` | tipo `02` = macro, `00 00` = desplazamiento en el bloque, `0A 00` = longitud (10 bytes) |
| `0x400` | `01 00 85 25 0A 25 00 00 01 00` | los 10 bytes del flujo de la macro |

Dentro del flujo aparecen **usages HID de teclado**: `0x25` es la tecla `8` (`0x1E`
= `1`, `0x1F` = `2`… `0x26` = `9`), que es exactamente la tecla de esa macro. O sea
que el ratón guarda las teclas como usages HID, y un botón puede ejecutarlas sin la
aplicación del fabricante.

El editor de macros admite además pasos de tipo XY (movimiento), CPI (cambio de
DPI), LED y retardos, y opciones de repetición («Run Until release», «Run Until
Click», «Repeat On = N»).

## 5-quater. LED: el bloque de luces está descifrado

Medido con el arnés de Wine: se cambia **un** campo del `config.ini` que la
herramienta carga, se ejecuta, y se compara la imagen que escribe con la base
(`tools/probe/led_sweep.py`, resultados en `tools/probe/led_map.json`).

| byte | contenido |
|---|---|
| `0x1C` | nibble alto = `LED_TYPE` (efecto); bajo = `LED_CYCTIME` (se recorta a 0–7) |
| `0x1D` | `0x80 \| CYC_7COL_EN`: un bit por color, los que entran en el ciclo |
| `0x20–0x31` | **seis pares**: nibble alto = `LED_USER0…5` (color de usuario), bajo = `DPI0…5` (color de la etapa) |
| `0x3A` | bit `0x40` = `LED_FEATURE_SYMMETRY`, bit `0x10` = `LED_FEATURE_DIREC`; el resto (`0x0D` de fábrica) no se toca |
| `0x3E` | nibble alto = `LED_USER6_R`, nibble bajo = `LED_USER6_G` |
| `0x3F` | nibble alto = `LED_BRIGHT` (0–15); nibble bajo = `LED_USER6_B` |

**El nivel va invertido.** El LED es activo a nivel bajo: el byte guarda la
"oscuridad" del canal y enciende con `15 − valor`. El canal sí está en su sitio
(`0x20` R, `0x21` G, `0x22` B y en el 7º color `0x3E` alto R, `0x3E` bajo G,
`0x3F` bajo B); lo que está al revés es el nivel.

Medido en el ratón, escribiendo tríos puros:

| se escribe | se ve |
|---|---|
| `(15,0,0)` | `(0,255,255)` cian |
| `(0,15,15)` | `(255,0,0)` rojo |
| `(15,0,15)` | `(0,255,0)` verde |

O sea: para pintar rojo hay que guardar `(0,15,15)`. El `config.ini` del
fabricante no aplica esa inversión al leer ni al escribir, así que sus valores
no son el color que sale; el configurador la hace en `web/core.js` (`lit()`), y
el resto de la UI sigue hablando de `{r,g,b}` normales.

Sin confirmar: si el **brillo** (`0x3F` alto) va invertido también. Con el brillo
a 0 de fábrica el ratón se enciende, así que o no va invertido o 0 significa
"sin atenuar"; el configurador lo escribe tal cual hasta saberlo.

Los canales son de **4 bits (0–15)**, igual que en el `config.ini`. Contrastado
color a color con la configuración de fábrica: los siete `LED_USER*` y los seis
`DPI*` salen exactamente como están en el ini, `LED_BRIGHT=0` con el nibble a 0,
`CYC_7COL_EN=127` con los siete bits puestos y `LED_TYPE=9` es el modo que la
herramienta llama **Star Trek**.

Cambiar el brillo de 0 a 1 mueve sólo `0x3F` (`0x00→0x10`), y de 0 a 7 lo pone
en `0x70`; cambiar un color mueve **sólo** su byte, en el nibble que le toca.

**Modos: el firmware sólo tiene OCHO, ids 8–15.** El desplegable del fabricante
tiene 14 entradas, pero se repiten encima: al elegir cada una y pulsar Apply, la
herramienta escribe el byte que se ve abajo. Medido dos veces (forzando
`LED_TYPE` en el ini y eligiendo el elemento en la UI con clic sostenido;
`tools/probe/led_names_ui.py`, resultados en `tools/probe/led_names_ui.json`).

| entrada del desplegable | `0x1C` alto |
|---|---|
| 1 Breathing | 8 |
| 2 Cycle breath | 9 |
| 3 Constantly | 10 |
| 4 Flow water | 11 |
| 5 Single water | 12 |
| 6 Comet tail | 13 |
| 7 Neon | 14 |
| 8 Ambilight | 15 |
| 9 Flicker | **8** (= Breathing) |
| 10 Star Trek | **9** (= Cycle breath) |
| 11 Water | **10** (= Constantly) |
| 12 enraptured | **11** (= Flow water) |
| 13 Button response | 9 (y además cambia el tiempo de ciclo) |
| 14 Mute | 8 (y además cambia el tiempo de ciclo) |

O sea que "Flicker", "Star Trek", "Water" y "enraptured" no son efectos distintos
en este ratón: son alias que acaban en los mismos ids. El configurador ofrece los
ocho de verdad (`LED_MODE_IDS` en `web/g6.js`) con el alias entre paréntesis, y
marca como desconocido un id fuera de 8–15 (que es lo que dejaban versiones
anteriores de la herramienta, que escribían el índice de la lista).

El **tiempo de ciclo** está en el nibble bajo de `0x1C` y se recorta a 0–7. Las
entradas "Button response" y "Mute" son las únicas que lo tocan (12 y 7), así que
su comportamiento completo no está claro: podrían ser modos reactivo/apagado que
este firmware no implementa igual.

**Lo que no llega a la imagen** (barrido sin ningún byte cambiado): `LED_CYC_TIME`
(la velocidad del ciclo), `LED_USER_COLOR`, `LED_FEATURE_SCOLOR`, `LED_TYPE_SW_EN*`,
`WHEEL_SPEED`, `DPI_SPEED` y los `LED_REACT_*` por botón. O viven en los registros
de `0x00A0–0x02CF`, o los aplica el firmware sin guardarlos.

**Sin resolver.** `0x33` cambia al cambiar de modo (`0xBF` con Star Trek, `0x3F`
con Breathing) y no sabemos qué es; el configurador no lo toca. `0x32–0x39` están
a cero en la imagen de fábrica. `LED_CYCTIME` sólo se ha visto recortado (15→7).

### Cómo lo usa el configurador web

`web/core.js` codifica una macro como **10 bytes por paso** (`01 00 83 <usage>
<retardo> <usage> 00 00 01 00`), la misma forma que la captura de un paso del
fabricante, y la asigna al botón con `0x2D` + el registro de la ranura. El byte
`0x83` es el de la captura «map»; en «first aid» el fabricante puso `0x85`, así
que ese byte sigue abierto: **las macros de más de un paso son una extrapolación
y no están probadas en el ratón**. El editor limita a 16 pasos (168 B de `0x400`,
el bloque completo) y no escribe un flujo que no quepa.

### Lo que falta para «asignar una tecla directamente»

El flujo de 10 bytes de «first aid» codifica **dos** pasos de tecla en 10 bytes, así
que cada paso ocupa ~5 bytes (usage + retardo + flags), pero con una sola muestra no
se puede fijar el reparto exacto. Plan para cerrarlo:

1. Crear tres macros de un solo paso en la herramienta (tecla `A`, `Shift` solo,
   `Ctrl+C`) con el diálogo «Please enter the key».
2. Aplicar y volcar: cada flujo tendrá 5 bytes y el usage dirá qué campo es cuál.
3. Con eso, «asignar tecla» = escribir un flujo de 5-10 bytes + el registro
   `01 02 ff…` + el byte `0x2D` en el botón. La interfaz puede mostrarlo como
   «Tecla: Shift» sin que el usuario vea macros.

Receta para manejar la herramienta bajo Wine (necesaria para esos volcados):

```bash
docker exec g6re-run bash /work/tools/probe/ui.sh start     # arranca la app
docker exec g6re-run bash /work/tools/probe/ui.sh click 371 212   # pestaña Macro
docker exec g6re-run bash /work/tools/probe/ui.sh shot paso1
docker exec g6re-run bash /work/tools/probe/ui.sh save mi_captura
```

Ojo: el botón Apply sólo responde si antes se mueve el cursor encima
(`move 853 850` y después `click 853 850`), y el grabador de macros no captura
teclas sintéticas de `xdotool`; hay que usar Insert → «Please enter the key».

## 6. Qué queda abierto

* Correspondencia **código DPI → dpi real** (medir en el ratón).
* Reparto/allocación de los **registros de acciones avanzadas** (`0x0490`, `0x04a8`,
  `0x0460`… según qué botones las usan).
* Formato de los **registros de acciones avanzadas y macros** (`0x00A0–0x02CF`,
  `0x0400–0x04A7`): se generan al elegir acciones ≥21 y contienen los punteros de
  `0x006E`. Sin descifrar.
* Codificación de **colores LED** por etapa, `LED_CYC_TIME`, `WHEEL_SPEED`,
  `DPI_SPEED` (los incrementos de 1 no cambian ningún byte: o se cuantizan o viven
  en los registros).
* Semántica de lectura multi-byte (índice como desplazamiento).
* Si `0x0080–0x009F` es almacenamiento de perfiles 3/4 sin usar.

## 7. Cómo seguir investigando

```bash
# imagen de Wine lista para el EXE + el shim
docker build -f tools/Dockerfile.wine -t g6re:local .
docker run -d --name g6re-run -v "$PWD":/work -w /work g6re:local sleep infinity

# una pasada: arranca, pulsa OK, guarda el tráfico en tools/probe/<nombre>.log
docker exec g6re-run bash /work/tools/probe/probe.sh baseline

# cambiar un campo y ver qué bytes cambian
python3 tools/probe/sweep.py Config0.K0 ShareData.DPI_SET0

# recomponer la memoria que el programa escribió
python3 tools/probe/parse_log.py tools/probe/baseline.log --mem
```

En hardware real, lo primero es confirmar la lectura:
`python3 tools/g6cli.py dump` (guarda un backup) y comparar con lo que escribe el
programa del fabricante para la misma configuración.
