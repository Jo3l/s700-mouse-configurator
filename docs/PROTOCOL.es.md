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
| API usada | `HidD_SetFeature` / `HidD_GetFeature` en un handle `CreateFile(..., GENERIC_READ\|GENERIC_WRITE)` |

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
completa — los 132 bloques de `WRITE_BLOCKS`, en el mismo orden que usa el
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
| `0x006E–0x007F` | punteros de «siguiente hueco» de la biblioteca de macros + suma de comprobación — se mueven con la biblioteca (§5-ter) |
| `0x00A0–0x02CF` | las diez ranuras de botón (10 B cada una, §5-ter), los cinco registros compartidos de `0x14A`–`0x18F` y las copias de los punteros de la biblioteca dentro de los dos registros de multimedia (`0x0203`, `0x028F`) |
| `0x0400–0x0567` | **área de macros**: `0x0400–0x04BF` arena de los flujos de los botones, `0x04C0–0x0567` biblioteca de macros (§5-ter) |
| `0x0080–0x009F` | **no** se escribe con la configuración por defecto (¿perfiles sin usar?) |

El programa **escribe siempre** `0x0001`, `0x006E` (2 bytes) y los 15 bloques de
`0x0008` a `0x007F`, más `0x00A0–0x02CF` y `0x0400–0x0567`. Nunca escribe
`0x0080–0x009F` en el perfil 1. El configurador escribe esos mismos 132 bloques en cada Apply.

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

Esos valores `0x89`, `0x8c`, `0x82`, `0x88` se leyeron al principio como **máscaras de
modificadores HID**; no lo son. Son el byte de tipo de §5-ter (el número de palabras del flujo,
`0x80 | palabras`) y el `0x04xx` es la dirección absoluta del flujo, así que estos cinco registros
son el mismo fondo compartido que usan las macros, y los ids 50–53/259 son entradas de la
biblioteca del propio fabricante, no atajos.

Las capturas de atajos de este grupo escriben `01 00` + cuatro pares (opcode, usage) en el registro
de `0x186`: `Ctrl+C` → `ef ad 13 0a`, `Ctrl+A` → `cc a8 0e 0a`, `Win+E` → `dd be 03 0a`. Los opcodes
cambian con el atajo y la regla que los genera no se ha encontrado, así que todavía no se puede
sintetizar un atajo nuevo (§6).

**Sin resolver:** cómo se reparten los registros cuando varios botones usan funciones avanzadas (la
tabla de punteros de `0x006E` cambia de base: `0x0490`, `0x04a8`, `0x0460`…) y de dónde salen la
tecla y el modificador de un atajo (la herramienta tiene un diálogo «Please enter the key»).

> El descriptor del ratón **no tiene colección de teclado** (sólo ratón `0xFF00`, configuración
> `0xFF01` y consumidor `0x0C`) y el EXE del fabricante no importa `SendInput`/`keybd_event`, pero
> una tecla asignada a un botón **sí llega al sistema con la herramienta cerrada** — es lo que
> demuestra el mantener de §5-ter. O sea: la envía el firmware, por la colección de vendor.

## 5-ter. Macros y teclas: el área de macros

El contenido de las macros **sí se sube al ratón** en cada Apply: el bloque `0x0400` de la imagen
lleva el flujo de pasos y coincide con lo que muestra el editor. `constMacro.dat` (§5-quinquies) es
solo la biblioteca del PC desde la que la herramienta del fabricante llena ese bloque.

### Diseño: 192 B de arena y después la biblioteca de macros

| rango | contenido |
|---|---|
| `0x0400–0x04BF` | **arena**: flujos de los botones que llevan una tecla o una macro (192 B) |
| `0x04C0–0x0567` | **biblioteca de macros**: los flujos que no son de ningún botón (168 B) |
| `0x014A`, `0x0154`, `0x0168`, `0x0172`, `0x0186` | los cinco registros de la biblioteca, 10 B cada uno, con la misma forma que la ranura de un botón |
| `0x006E` (×4), `0x0079`, `0x007B`, `0x0203`, `0x028F` | punteros de «siguiente hueco» de la biblioteca |

La imagen de fábrica (`web/default_image.js`, reconstruida de `tools/probe/baseline.log`) tiene la
biblioteca **en `0x0400`** —dentro de la arena— y todo lo que la direcciona va con ella. Esa es la
trampa que costó dos sesiones: escribir una tecla en `0x0400` pisa la biblioteca mientras sus cinco
registros siguen apuntando allí, así que el firmware resuelve el flujo del botón contra la
biblioteca y ejecuta el equivocado. La herramienta del fabricante mueve biblioteca **y** registros
`+0xC0` (`LIB_BASE 0x04C0 − STREAM_BASE 0x0400`) al asignar el primer flujo de un botón;
`liftLibrary()` en `web/core.js` hace lo mismo al principio de cada `applyEdits` y es idempotente
(si los registros ya están en `0x04C0` o más arriba, no toca nada). Una captura de una configuración
que mantiene teclas tiene los registros en `0x04C0`/`0x04E0`/`0x0510`/`0x0540`/`0x0550` y los
punteros en `0x0568`…`0x0588`.

### El registro de ranura (10 bytes)

| byte | significado |
|---|---|
| 0 | `0x01` |
| 1 | tipo: **número de pasos** (Repeat On, hasta clic) o **`0x80 \| palabras`** (hasta soltar) |
| 2 | `0xFF` |
| 3–4 | parámetro: usage de consumidor en los registros de multimedia, `0x0000` en las macros |
| 5–6 | **dirección del flujo, uint16 little-endian, absoluta** (`0x0400` + desplazamiento) |
| 7 | `0x04`, igual en los tres modos de repetición |
| 8–9 | longitud; `0x000A` en todos los registros que escribe el configurador |

Las primeras builds del configurador ponían el desplazamiento en los bytes 3–4, así que el firmware
leía `0` en todos los registros y **todos los botones ejecutaban el primer flujo** (cuatro botones
con W, Shift, O e I escribían `W`); esas imágenes se siguen leyendo con un respaldo. Los bytes 5–6
son una dirección absoluta, no «desplazamiento más un `0x04` fijo»: el `0x04` es el byte alto de
`0x04xx`. Los registros de la biblioteca, que vive por encima de `0x0500`, llevan `0x0510`,
`0x0540`, `0x0550`.

### Formatos de flujo

Un flujo empieza con un **contador de repeticiones uint16** (solo lo usa «Repeat On»; los otros
modos escriben `1`) y sigue con elementos de longitud variable:

| bytes | significado |
|---|---|
| `83 <usage> <delay> <usage> 00 00` | toque de tecla, 6 B, lleva su propio soltar (`85` aparece en el `first aid` del fabricante y se acepta al leer) |
| `83 <usage>` / `82 <usage>` | tecla abajo / tecla arriba, 2 B cada uno |
| `81 <code>` / `01 <code>` | botón del ratón abajo / arriba, `f1`/`f2`/`f3` = izquierdo/central/derecho |
| `01 f6 <x16> <y16>` | mover, int16 con signo |
| `81 f8 <dpi/200>` / `01 f8 <dpi/200>` | fijar / restaurar DPI |
| `01 f9 <…>` | paso LED (carga útil sin descifrar, de solo lectura en el configurador) |
| `00 <ms/2> 00` | retardo en unidades de 2 ms (`00 01 00` = 2 ms) |

Las teclas son **usages HID** (`0x04` A, `0x14` Q, `0x1A` W, `0xE1` LShift). El `.dat` del
fabricante guarda códigos de tecla virtuales de Windows y los convierte al subir el flujo
(§5-quinquies).

El byte de tipo **está descifrado**: el bit 7 marca la familia «hasta soltar» y los siete bits bajos
son el número de palabras de 2 bytes del cuerpo del flujo —la longitud no se guarda en ningún otro
sitio, y así sabe el firmware dónde termina—. Doce capturas lo confirman: 20 palabras
`81 <usage>` → `0x94`, una macro de nueve toques (54 B) → `0x9b`, 13 pares abajo/arriba → `0x9a`. Un
recuento declarado que no cuadre con el flujo hace que el firmware lo lea mal.

### Las tres formas de poner una tecla en un botón — todas medidas en el ratón

| modo en la UI | lo que se escribe | tamaño | comportamiento |
|---|---|---|---|
| **mantener al pulsar** (por defecto) | acción `0x2E`, ranura `01 94 ff 00 00 <addr> 04 00 0A 00`, flujo `01 00` + 20× `81 <usage>` | 42 B | **mantiene**: la tecla baja al apretar el botón —con el auto-repeat del sistema, como una tecla real— y sube al soltarlo |
| **un toque** | acción `0x2D`, tipo `0x02`, flujo `01 00 83 <usage> <delay> <usage> 00 00` (la macro `map` del fabricante) | 8 B | un toque por pulsación; lleva su soltar dentro, así que no puede quedarse pegada |
| **toques mientras se mantiene** | acción `0x2D`, tipo `0x80 \| 2·pares`, flujo `01 00` + pares `81 <usage> 01 <usage>` (captura `tap_q`) | 2 + 4·pares | toques mientras se mantiene el botón; cada par suelta antes del siguiente |

El mantener es la forma del propio fabricante —veinte copias **y** `0x2E` es exactamente lo que
llevan las capturas `kd_shift` y `kd_q`— y solo funciona con la biblioteca fuera de la arena (arriba).
Capacidad dentro de los 192 B de arena, con la alineación de 8 bytes que espera el firmware:

| modo | bytes por tecla | teclas que caben |
|---|---|---|
| mantener | 42 | **4** |
| un toque | 8 | 24 (el ratón solo tiene 10 botones, así que todos) |
| toques mientras se mantiene | 2 + 4·pares (18 con 4 pares, alineado a 24) | 8 |

Las macros comparten esa arena con las teclas, así que el límite son bytes y no pasos: una macro
ocupa `2 B + sus pasos` (alineado a 8), o sea que una macro de 21 toques son 128 B y dejan sitio
para una sola tecla mantenida (42 B). Un flujo que no cabe no se escribe: el botón conserva su
acción anterior y la tabla avisa con `No room for button N…`; la pestaña Macros dice cuánto de los
192 B hay en uso.

### El byte de acción dice QUÉ lanza, no CÓMO se repite

`0x2D` es la macro **inline** (el camino de `Convert K1 to a macro` del fabricante, dentro del
bloque del propio botón) y `0x2E` la macro de la **biblioteca**; el desensamblado tiene exactamente
dos sitios que las escriben (`0x534797` → `0x2E`, y `0x53478E` → `0x2F` para multimedia). Asignar la
misma macro `mirror` con los modos `01` y `02` escribió acción y ranura idénticas
(`01 82 ff 00 00 10 04 00 0A 00`), y con el modo `00` escribió `0x2D`: la diferencia es el camino de
asignación (biblioteca o inline), no el modo. El byte 7 de la ranura tampoco cambia con el modo —el
`0x84` que las notas anteriores leían como «Run until click» es el byte 8 del registro—. Dónde vive
el modo dentro de la macro sigue abierto: es `0x3C` en el `.dat` y la copia en el ratón de esa
cabecera no se ha localizado.

Las macros de varios pasos son el mismo registro de arena. El fabricante mueve su propio contenido
de la arena exactamente 8 bytes por macro insertada, así que **todo flujo empieza en un límite de 8
bytes**; un flujo en un desplazamiento desalineado resuelve al registro equivocado (eso, junto con el
byte del desplazamiento, es lo que mantenía vivo el «todos los botones ejecutan el primer flujo»). El
configurador escribe toques de tecla, botones del ratón, movimiento XY, DPI fijar/restaurar y
retardos, hasta 21 pasos (`MAX_STEPS`), y deja el paso LED de solo lectura porque su carga útil no
está descifrada.

## 5-quater. LED: los catorce efectos, medidos uno a uno

Medido conduciendo la herramienta del fabricante bajo Wine: se elige un efecto (o se mueve
uno de sus controles) en su UI, se pulsa Apply y se lee la imagen que escribe. Además la
herramienta deja guardado el `config.ini` que aplicó, que nombra cada campo que movió.
Instrumentos: `tools/probe/led_capture.py` (foto + imagen completa por cada entrada del
desplegable), `tools/probe/led_cases.py` (una lista de acciones de UI, un Apply por cada
una) y `tools/probe/led_sweep.py` (un campo del `config.ini` cada vez).

| byte | contenido |
|---|---|
| `0x1C` | nibble alto = id del efecto; bajo = velocidad del ciclo (`LED_CYCTIME`, 0–7) |
| `0x33` | bit `0x80` = el **segundo grupo de nombres** del fabricante; los bits bajos (`0x3F`) se quedan como estaban |
| `0x1D` | `0x80 \| CYC_7COL_EN`: un bit por color, los que entran en el ciclo |
| `0x20–0x31` | **seis pares**: nibble alto = `LED_USER0…5` (color de usuario), bajo = `DPI0…5` (color de etapa) |
| `0x3A` | bit `0x40` = simetría; bits `0x10`/`0x20` = dirección (0 clockwise, 1 inverse, 2 two way, 3 magicalady) |
| `0x3E` | nibble alto = `LED_USER6_R`, bajo = `LED_USER6_G` |
| `0x3F` | nibble alto = `LED_BRIGHT` (0–15); bajo = `LED_USER6_B` |

### Los catorce efectos y lo que escribe cada uno

El desplegable tiene **14** entradas y su valor es `LED_TYPE` del `config.ini` (0–13). La
herramienta escribe el nibble alto de `0x1C` como `8 + (LED_TYPE mod 8)`, así que los ocho
primeros nombres cubren los ids 8–15 — pero el segundo grupo de nombres **no** es un
duplicado: con `LED_TYPE` 8–11 la herramienta pone además el bit 7 de `0x33`, y eso es otra
animación. `Button response` (12) y `Mute` (13) conservan el id 9 y se codifican en el
**nibble del ciclo**, el único sitio donde la herramienta escribe fuera de 0–7.

| entrada | `LED_TYPE` | `0x1C` | `0x33` | controles que enseña |
|---|---|---|---|---|
| Breathing | 0 | `8n` | `3F` | velocidad |
| Cycle breath | 1 | `9n` | `3F` | velocidad, 7 colores + casillas |
| Constantly | 2 | `An` | `3F` | brillo |
| Flow water | 3 | `Bn` | `3F` | velocidad, brillo, colores, simetría, 4 direcciones |
| Single water | 4 | `Cn` | `3F` | velocidad, brillo, colores, simetría, 3 direcciones |
| Comet tail | 5 | `Dn` | `3F` | velocidad, brillo, colores, simetría, 3 direcciones |
| Neon | 6 | `En` | `3F` | velocidad |
| Ambilight | 7 | `Fn` | `3F` | velocidad, simetría, 2 direcciones |
| Flicker | 8 | `8n` | `BF` | velocidad |
| Star Trek | 9 | `9n` | `BF` | — |
| Water | 10 | `An` | `BF` | velocidad, 2 direcciones |
| enraptured | 11 | `Bn` | `BF` | velocidad |
| Button response | 12 | `9C` | `3F` | una animación por botón (abajo) |
| Mute | 13 | `97` | `3F` | — |

`n` = la velocidad del ciclo (0–7). Las dieciséis combinaciones de opciones se midieron
efecto por efecto y todos los controles escriben el mismo campo del `config.ini` dé igual
cuál esté en pantalla: el slider de velocidad mueve `LED_CYCTIME` **y** `LED_CYC_TIME`, el
de brillo mueve `LED_BRIGHT`, las siete casillas mueven `CYC_7COL_EN`, la simetría mueve
`LED_FEATURE_SYMMETRY` y los radios de dirección mueven `LED_FEATURE_DIREC` (0/1/2/3 → bits
4–5 de `0x3A`). En la imagen no hay nada por efecto: el efecto es el id y las opciones son
el bloque LED compartido.

Los sliders del fabricante no usan el nibble entero: llevando el de **brillo** de su extremo
derecho al izquierdo sale `LED_BRIGHT` 0 → 6 (0 es el valor de fábrica y el que enciende el
ratón a tope), y el de **velocidad** da 0 → 5. El campo del firmware es un nibble de 4 bits,
así que el configurador ofrece 0–15 y 0–7.

**El nivel está invertido.** El LED es activo a nivel bajo: el byte guarda la "oscuridad"
del canal y enciende con `15 − valor`. El canal sí está en su sitio (`0x20` R, `0x21` G,
`0x22` B y en el 7º color `0x3E` alto R, `0x3E` bajo G, `0x3F` bajo B); lo que va al revés es
el nivel. Medido en el ratón, escribiendo ternas puras:

| escrito | visto |
|---|---|
| `(15,0,0)` | `(0,255,255)` cian |
| `(0,15,15)` | `(255,0,0)` rojo |
| `(15,0,15)` | `(0,255,0)` verde |

O sea: para pintar rojo hay que guardar `(0,15,15)`. El `config.ini` del fabricante no
aplica esa inversión, así que sus valores no son el color que sale; el configurador la hace
en `web/core.js` (`lit()`) y el resto de la UI sigue hablando de `{r,g,b}` normales.

Sin confirmar: si el **brillo** (`0x3F` alto) va invertido también. Con el brillo a 0 de
fábrica el ratón enciende, así que o no va invertido o 0 significa "sin atenuar"; el
configurador lo escribe tal cual hasta saberlo.

Los canales son de **4 bits (0–15)**, como en el `config.ini`. Contrastado color por color
con la configuración de fábrica: los siete `LED_USER*` y los seis `DPI*` salen exactamente
como están en el ini, y `CYC_7COL_EN=127` con los siete bits puestos. Cambiar el brillo de 0
a 1 mueve sólo `0x3F` (`0x00→0x10`), y de 0 a 7 lo deja en `0x70`; cambiar un color mueve
**sólo** su byte, en el nibble que le toca.

**Qué hace el ratón.** Mirando el LED y escribiendo cada valor del nibble alto sobre la
imagen de fábrica (`0x33 = 0xBF`, o sea el *segundo* grupo): el id 8 parpadea nervioso, el 9
se queda en color fijo, el 10 respira pero con colores propios, el 11 recorre tipo "Star
Trek" y los ids 12–15 no encienden nada. De ahí venía el «los nombres del fabricante son
ficción» de versiones anteriores de este documento; ahora que los ids 8–11 existen **dos
veces**, la lectura honesta es que se midieron los nombres del segundo grupo (Flicker, Star
Trek, Water, enraptured) y el primero no, así que las animaciones de `Breathing`…`Ambilight`
(banco 0) y las de los ids 12–15 están **sin observar en hardware**. La sonda de bytes del
panel Debug es la forma de cerrarlo.

### Button response: una animación por botón

Las cuatro animaciones son la lista de la propia herramienta — las cadenas están en su
`.exe`: «1.Cycle breath 2.Flow water 3.Comet tail 4.Single water». No van en el bloque LED:
el **byte de acción** de cada botón (`0x0008–0x000F`, `0x003B–0x003C`) las lleva en sus bits
altos, junto a la acción:

```
bits 7-6   animación: 0 Cycle breath, 1 Flow water, 2 Comet tail, 3 Single water
bit  5     react activado (el LED_REACT_EN del ini; 1 en la imagen de fábrica)
bits 4-0   la acción (0x21 = Left, 0x27 = Show Desktop, …)
```

Medido botón a botón, `LED_REACT_TYPE<i>` = 1 → el byte sube `0x40`
(`tools/probe/react_map.py`, `react_sweep.py`):

| `LED_REACT_<i>` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| byte | `0x08` | `0x0A` | `0x09` | `0x0C` | `0x0B` | `0x0D` | `0x3B` | `0x3C` | `0x0F` | `0x0E` | — | — |

(índice 0 = Left, 1 = Right, 2 = Middle, 3 = Forward, 4 = Backward, y luego los botones
propios del modelo; 10 y 11 no se escriben en ningún sitio).
`LED_REACT_EN<i> = 0` borra el bit 5 de ese mismo byte — `0x21` (Left) → `0x01` —, que es el
aspecto de una animación "apagada", y por eso el configurador lo avisa: es la codificación
del propio fabricante y está **sin verificar en hardware** que el botón siga funcionando con
el bit 5 a cero.

Como la animación comparte byte con la acción, escribir una no puede pisar la otra:
`web/core.js` conserva los bits 7–6 cuando se escribe una acción y los bits 4–0 cuando se
escribe la animación.

### Manejar la herramienta del fabricante bajo Wine (arnés)

Las capturas de §5-bis a §5-quinquies salen del EXE del fabricante corriendo bajo Wine con
`tools/hid_shim.c` suplantando `HID/SetupAPI`. Receta para una pasada:

```bash
docker exec g6re-run bash /work/tools/probe/ui.sh start     # arranca la app
docker exec g6re-run bash /work/tools/probe/ui.sh click 371 212   # pestaña Macro
docker exec g6re-run bash /work/tools/probe/ui.sh shot paso1
docker exec g6re-run bash /work/tools/probe/ui.sh save mi_captura
```

Ojo: el botón Apply sólo responde si antes se mueve el cursor encima
(`move 853 850` y después `click 853 850`), y el grabador de macros no captura
teclas sintéticas de `xdotool`; hay que usar Insert → «Please enter the key».

## 5-quinquies. El fichero de la biblioteca de macros (`constMacro.dat`, `PUBG3 V6.48.dat`)

Las macros de la herramienta viven en un fichero de texto con forma de ini que va junto al
EXE (`/app/constMacro.dat`). Es la copia del *PC*: `DAT_VER=3`, `macroNum=N` y una línea
por macro, `<índice>=<bytes>`, donde **cada byte se escribe con tres dígitos decimales**
(`109000105000`… = `6D 00 69 00 50 00`…). Cada registro mide 2621 bytes:

| bytes | contenido |
|---|---|
| `0x00–0x3B` | nombre en UTF-16LE, 30 caracteres (`mirror`, `first aid`, `一刀毙命`…) |
| `0x3C` | modo de repetición: `00` = Repeat On, `02` = Run until release (medido) |
| `0x3F` | **número de pasos** (`02` en `mirror`, `08` en `DPI Shift`, `03` y `01` en la muestra de abajo) |
| `0x3D`–`0x50` | banderas: `0x3D` = `01` y `0x4C` = `0A` en *todos* los registros medidos, `0x45` = `01` sólo en la macro que cambia DPI. Sin descifrar |
| `0x51` en adelante | pasos, **8 bytes cada uno**: `01 <tecla> 00 00 00 00 <delay_lo> <delay_hi>` |

Los dos bloques **no van en un orden fijo**: `PUBG3 V6.48.dat` empieza por `[Macros]` y
termina con `[Init]`/`DAT_VER=3`, mientras que una exportación hecha por la herramienta
escribe `[Init]` primero. Se lee por nombre de clave, nunca por posición de línea.

Tipos de paso vistos en los ficheros del fabricante: `01` = tecla pulsada, `02` = tecla
soltada, `00` = retardo, `09` = cambio de DPI. El campo de tecla lleva un **código de
tecla virtual de Windows**, no un usage HID (`0xA0` LShift, `0x57` W, `0x4D` M, `0x38` `8`,
`0x4F` O, `0xF1` botón derecho = el `R-KEY` que muestra la herramienta); la herramienta
convierte VK → usage HID al subir el flujo. El retardo es **por paso**, de 16 bits en little
endian, en milisegundos; un paso `00` es un retardo puro y no lleva nada más que ese número.
La herramienta escribe paso de soltada (`02`) para los botones del ratón pero **no** para
las teclas de teclado que ella misma crea, así que dónde se sueltan ésas sigue sin saberse.

Comprobado contra lo que muestra la UI del fabricante para ese fichero (pestaña Macro, árbol
`PUBG3 V6.48`):

| macro | filas de la UI | bytes |
|---|---|---|
| mirror | R-KEY 30 ms, R-KEY 1 ms | `01 f1 … 1e 00`, `02 f1 … 01 00` |
| run | LSHIFT 20 ms, W 4104 ms | `01 a0 … 14 00`, `01 57 … 08 10` |
| map | M 10 ms, M 30 ms | `01 4d … 0a 00`, `02 4d … 1e 00` |
| first aid | 8 10 ms, 8 20 ms | `01 38 … 0a 00`, `02 38 … 14 00` |
| DPI Shift | R-KEY 10, R-KEY 10, DPI:400 254, cuatro retardos | `01 f1`, `02 f1`, `09 f8 02 … fe 00`, luego pasos `00` |

La aplicación sólo lista `macroNum` entradas (el fichero de arriba trae 7 y muestra 5).

Una tercera muestra, exportada por la herramienta tras crear dos macros en una biblioteca
vacía (`macro.dat`, `macroNum=2`, `[Init]` primero): `w` = tecla W, una fila de retardo de
1 ms, tecla O, y `o` = la tecla O sola. Los bytes son exactamente el formato de arriba y
fijan dos cosas que eran suposiciones:

| macro | `0x3F` | pasos desde `0x51` |
|---|---|---|
| w | `03` | `01 57 00 00 00 00 01 00` · `00 00 00 00 00 00 01 00` · `01 4f 00 00 00 00 01 00` |
| o | `01` | `01 4f 00 00 00 00 01 00` |

Así que una macro de teclas de varios pasos escrita por la herramienta es simplemente N
pasos de 8 bytes, la fila de retardo es un paso `00` sin nada más que su retardo, y **cada
paso lleva su propio retardo** (la herramienta puso 1 ms en todos, incluida la macro de una
sola tecla). Que `0x3F` sea el número de pasos lo confirman todos los registros medidos
(aquí `03`/`01`, `02` en `mirror`, `08` en `DPI Shift`).

**Crear una macro de tecla en la aplicación del fabricante.** *Insert* sólo ofrece `Insert
XY`, `Insert CPI`, `Insert LED`, `Insert (delay)` e `Insert before/after item`, y ese submenú
lista únicamente **Left / Mid / Right button**: no hay entrada de teclado, y eso es lo que
hace parecer que el editor no puede añadir teclas. Las teclas entran por el **grabador**, y
el grabador sí funciona: el fichero `w`/`o` de arriba se grabó con él en la herramienta. Lo
que ignora son las teclas sintéticas lanzadas con `xdotool` bajo Wine
(`tools/probe/ui.sh`), y por eso el diálogo «Please enter the key» nunca salió en las
capturas automáticas. Los pasos de tecla que ya existen también se pueden reapuntar a otra
tecla desde esa lista. El configurador no tiene ese límite: su pestaña Macros crea pasos con
cualquier tecla y su retardo.

## 6. Qué queda abierto

* Correspondencia **código DPI → dpi real** (medir en el ratón).
* Dónde se guarda el **modo de repetición** (Repeat On / hasta clic / hasta soltar) *en el ratón*:
  es `0x3C` en el `.dat` y el byte de acción no lo lleva (§5-ter), pero la copia en el ratón de esa
  cabecera no se ha localizado. Relacionado: qué significan las banderas `01` en `0x40`/`0x44`/`0x48`
  de los registros del `.dat` (aparecen en las macros con pasos XY/LED/CPI).
* La **carga útil del paso LED** (`01 f9 …`): el fabricante la escribe desde su configuración global
  y no está descifrada, así que el editor de macros la deja de solo lectura.
* Los **opcodes de los atajos** del grupo `0x3e`/`0x3f` (§5-bis): `Ctrl+C` → `ef ad 13 0a`, `Ctrl+A`
  → `cc a8 0e 0a`, `Win+E` → `dd be 03 0a`; la regla que los genera no se ha encontrado, así que
  todavía no se puede sintetizar un atajo nuevo desde la UI.
* Codificación de **colores LED** por etapa, `WHEEL_SPEED` y `DPI_SPEED` (los
  incrementos de 1 no cambian ningún byte: o se cuantizan o viven en los registros).
  `LED_CYC_TIME` por sí solo tampoco cambia nada: la herramienta lo escribe **junto a**
  `LED_CYCTIME` y la imagen se queda con el segundo (`0x1C`, nibble bajo).
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

# conducir la UI del fabricante: un Apply por caso y el config.ini que guardó
python3 tools/probe/led_cases.py tools/probe/cases_fw.json
# foto + imagen completa por cada entrada del desplegable de luces
python3 tools/probe/led_capture.py
# "button response" por botón: qué byte mueve cada LED_REACT_TYPE
python3 tools/probe/react_map.py

# recomponer la memoria que el programa escribió
python3 tools/probe/parse_log.py tools/probe/baseline.log --mem
```

En hardware real, lo primero es confirmar la lectura:
`python3 tools/g6cli.py dump` (guarda un backup) y comparar con lo que escribe el
programa del fabricante para la misma configuración.
