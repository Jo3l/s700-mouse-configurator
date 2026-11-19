# S700 (HXSJ) protocol — reverse-engineering notes

Everything here is **verified** by running the vendor program
(`original/S700 Gaming Mouse.exe`) against a simulated mouse, except what is
explicitly marked as *inferred* or *unconfirmed*.

The method is in [`tools/`](../tools): the EXE runs under Wine and an in-house DLL
(`tools/hid_shim.c`) impersonates `HidD_*` and `SetupDi*` to capture every HID report.
`tools/probe/probe.sh` launches the program, presses OK and dumps the traffic
to a log; `tools/probe/sweep.py` changes one field of `config.ini` at a time and records
which bytes of the mouse change.

---

## 1. HID interface

The program uses no files for the mouse: it opens the **vendor collection** and talks over
*feature* reports.

Actual mouse descriptor (read with WebHID on 16/11/2026, VID:PID `30fa:1540`,
product «USB GAMING MOUSE»):

| Collection | Reports |
|---|---|
| `UsagePage 0xFF00`, `Usage 0x01` | **input** 6 (mouse data), no feature |
| `UsagePage 0xFF01`, `Usage 0x01` | **feature 7: 56 bits = 7 bytes** (configuration) |
| `UsagePage 0x0C` (consumer), `Usage 0x01` | input 2 (multimedia) |

| Item | Value |
|---|---|
| Configuration collection | `UsagePage 0xFF01`, `Usage 0x01` |
| Report | *feature* **report ID 7, 7 bytes of data** (8 with the ID) |
| VID/PID accepted by the program | `0x30FA` with `0x1540` or `0x1E01` (it compares `HIDD_ATTRIBUTES` and a list of product names) |
| API used | `HidD_SetFeature` / `HidD_GetFeature` on a `CreateFile(..., GENERIC_READ\|GENERIC_WRITE)` handle |

> **Watch the size.** The vendor program passes a 65-byte buffer and the HID stack
> trims it to 8 without complaint; WebHID (and `hidapi` on Windows) require the exact
> size the descriptor declares, so sending 64 bytes of data gives
> `Failed to write the feature report`. The real frame is **7 bytes of data**.

It does not use `WriteFile`/`ReadFile`: feature reports only, which **makes WebHID viable**
in the browser (`sendFeatureReport` / `receiveFeatureReport`).

## 2. Frame

```
byte 0   0x07            report ID (does not travel in the sendFeatureReport buffer)
byte 1   0x18            constant in every observed frame
byte 2   cmd             command (see table)
byte 3   index           position within the burst (0..n-1)
byte 4   addr_lo         address, low byte
byte 5   addr_hi         address, high byte
byte 6   data            data byte
byte 7   length-1        n-1 (0 when n = 1; 0 when not applicable)
```

| cmd | meaning |
|---|---|
| `0x03` | write one byte (it accumulates in the mouse buffer) |
| `0x05` | read one byte (the reply arrives in byte 6) |
| `0x09` | commit the block: writes what has accumulated at `addr` |
| `0x00` | end of transaction / no-op |
| `0x10` | end of session (on close) |

## 3. Write

For each 8-byte block (that is what the vendor uses; it also uses 1- and 2-byte blocks):

```
-> 07 18 03 00 08 00 21 07   write 0x21 at 0x0008 (index 0, length 8)
-> 07 18 03 01 08 00 22 07   index 1 ...
   ... 8 frames ...
-> 07 18 09 00 08 00 00 07   commit of the block at 0x0008
-> 07 18 00 00 08 00 00 00   end
```

Between frame and frame the program waits ~2 ms. The commit copies the buffer to the
mouse storage; the `cmd 0x09` frame carries the **start address** and
`length-1`.

## 4. Read

```
-> 07 18 05 00 76 00 00 00   read 1 byte at 0x0076
<- 07 18 05 00 76 00 XX 00   the reply repeats the header and brings the data in byte 6
```

The vendor program only reads **one byte** (address `0x0076`, at the end of the
upload).

> **Tested on hardware (17/11/2026): reading does not return the protocol.**
> `GetFeature(7)` on a `30FA:1540` («USB GAMING MOUSE», 7-byte report) from
> Chrome/Windows returns 8 bytes that start with the *report id* and continue with
> data that changes with movement (`07 01 5e 09 03 00 27 90`), never `18 05 …`,
> with any wait and with the 1-byte, burst and neighbouring-command variants
> tried. The `/dev/hidraw1` that shows up on the development machine **is not a
> second unit**: it is the virtual mouse that `tools/hid_shim.c` creates in the
> container (`/sys/devices/virtual/misc/uhid`), and it answers with the shim's
> `g_reply`, not with firmware.
>
> Matrix of what was tried on the `30FA:1540` (Chrome/Windows, 17/11/2026):
>
> | Test | Result |
> |---|---|
> | `GetFeature(7)` at rest, and after reading `0x0001`, `0x0008`, `0x0076` | always the same block unrelated to the protocol (`07 xx 5e 09 03 00 27 90`) |
> | waits of 2, 30, 150 and 300 ms | same |
> | burst reads (index 0..7, `len-1 = 7`) | same |
> | commands `0x00–0x0F`, `0x10–0x12` (without `0x09`, which writes) | same, only the first byte of the block changes |
> | input report 2 and 6 (`inputreport`) at rest and after each request | **none** (nothing is received) |
> | `GetFeature` of other report ids (0–6, 8, 15) | `NotAllowedError`: only 7 exists |
>
> Conclusion: there is no read channel. The firmware implements writing and nothing
> else, so the configurator does not read (nor does it try).
>
> Until that says otherwise, the firmware implements `SetFeature` but does not
> answer `GetFeature`, so the
> configurator **cannot read what the mouse has stored**. It works on the
> image that the vendor itself writes for its factory `config.ini`
> (`web/default_image.js`, generated from `tools/probe/baseline.log` with
> `tools/make_default_image.py`) and writes it the same way it does. Reading remains as a
> probe: if one day a unit answers, `state.canRead` becomes `true` and what was written
> is verified again by re-reading it.
>
> Note the Windows detail: `receiveFeatureReport` returns the *report id* as the
> first byte, so it has to be removed before interpreting the frame (otherwise
> everything comes out shifted by one byte).

### Write: the full image or nothing (confirmed on hardware, 17/11/2026)

Writing only the blocks that change **has no effect**: the mouse accepts the
commits (there is no error) and keeps running the previous configuration. With the full
image — the 132 blocks of `WRITE_BLOCKS`, in the same order the
vendor uses, with the pointer table at `0x006E` included — the change does apply.
That is why the configurator always sends the whole image.

## 5. Memory map

| Range | Content |
|---|---|
| `0x0001` | active profile: `0x03 \| (profile << 5)` → 0x03, 0x23, 0x43, 0x63 |
| `0x0008–0x000F` | buttons of **profile 0** (8 slots) |
| `0x0010–0x0017` | DPI (nibbles at `0x15..0x17`), `0x14` = DPI level |
| `0x0018–0x001F` | `0x1A` burst time, `0x1C` LED type, `0x1E` USB polling rate |
| `0x0020–0x003F` | LED colours per stage/level, `0x3F` brightness (high nibble) |
| `0x003B–0x003C` | buttons 7 and 8 of **profile 0** |
| `0x0044–0x004E` | buttons of **profile 1** |
| `0x0050–0x005A` | buttons of **profile 2** |
| `0x0060–0x006A` | buttons of **profile 3** |
| `0x006E–0x007F` | "next free" pointers of the macro library + checksum — they move with the library (§5-ter) |
| `0x00A0–0x02CF` | the ten button slots (10 B each, §5-ter), the five shared records at `0x14A`–`0x18F` and the copies of the library pointers inside the two media records (`0x0203`, `0x028F`) |
| `0x0400–0x0567` | **macro area**: `0x0400–0x04BF` arena of the buttons' flows, `0x04C0–0x0567` macro library (§5-ter) |
| `0x0080–0x009F` | **not** written with the default configuration (unused profiles?) |

The program **always writes** `0x0001`, `0x006E` (2 bytes) and the 15 blocks from
`0x0008` to `0x007F`, plus `0x00A0–0x02CF` and `0x0400–0x0567`. It never writes
`0x0080–0x009F` in profile 1. The configurator writes the same 132 blocks on every Apply.

### Buttons (profile 0 = the active one)

| Slot | Address | `config.ini` |
|---|---|---|
| left | `0x08` | K0 |
| right | `0x0A` | K1 |
| middle | `0x09` | K2 |
| forward | `0x0C` | K3 |
| back | `0x0B` | K4 |
| button 6 | `0x0D` | K5 |
| button 7 | `0x3B` | K6 |
| button 8 | `0x3C` | K7 |
| button 9 | `0x0F` | K8 |
| button 10 | `0x0E` | K9 |
| — | — | K10 is not written (it does not exist on this model) |

Profiles 1–3 use the same order but shifted: `0x44`, `0x50`, `0x60` are the
K0 slot of each one, with K6/K7 at `0x4D/0x4E`, `0x59/0x5A`, `0x69/0x6A`. The K9
slot only appears as a plain byte in profile 3 (`0x66`); in profiles 1 and 2
the default K9 action is an advanced function and is stored as a register.

### Action table (`config.ini` id → code on the mouse)

| id | code | id | code | id | code |
|---|---|---|---|---|---|
| 1 | `0x21` | 8 | `0x23` | 15 | `0x35` |
| 2 | `0x22` | 9 | `0x24` | 16 | `0x2B` |
| 3 | `0x23` | 10 | `0x25` | 17 | `0x2C` |
| 4 | `0x24` | 11 | `0x26` | 18 | `0x34` |
| 5 | `0x25` | 12 | `0x27` | 19 | `0x37` |
| 6 | `0x26` | 13 | `0x28` | 20 | `0x38` |
| 7 | `0x22` | 14 | `0x29` | ≥21 | advanced action → register |

Identifiers 1–6 are the standard buttons (left, middle, right,
back, forward); 12 "show desktop", 14 "autofire", 15 "LED loop", 16/17 DPI
+/−, 19 "switch LED". Codes 7–11 repeat those of 2–6: the mouse does not distinguish
those vendor variants.

### DPI

Six stages in 3 bytes, **two 4-bit codes per byte**, high nibble = even stage:

```
code(stage) = (setting + 1) & 0xF        if setting <= 9
              (setting + 2) & 0xF        if setting >= 10
```

Checked stage by stage: `5→6`, `7→8`, `8→9`, `10→12`, `12→14`, `15→1`, `16→2`,
`22→8`. With the factory configuration (`DPI_SET0..5 = 5,7,10,15,16,22`) the bytes
`0x15..0x17` come out `68 C1 28`.

> **Warning:** the counter stays at 4 bits, so different settings collapse into the
> same code (7 and 22 both give `8`). The dpi value the vendor tool
> shows (1200, 1600, 2400, 6400, 7200, 12800 for those settings) comes from its
> table, not from the byte. The **code → real sensor dpi** correspondence is **not
> confirmed** and has to be measured on the mouse.

### Other verified fields

| Address | Field | Check |
|---|---|---|
| `0x1E` | USB polling rate (index) | `2→3` changes the byte |
| `0x1C` | LED effect type | `9→10` changes the byte |
| `0x3F` (high nibble) | LED brightness | `0→1` turns `0x00` into `0x10` |
| `0x1A` | burst time | changes with `FIRE_TIME`, propagates to the registers |


## 5-bis. Actions: they are not only 20

The function list of the tool itself (`skins/INI_EN/skin_main_en.ini`,
section `[FUN_STRING]`) has **41 entries**. Measured with the harness, they are encoded in
three different ways:

| ids | encoding | where |
|---|---|---|
| 1–22 | **1 byte** at the button's address | `0x21 … 0x3a` |
| 23–32 (multimedia) | byte `0x2f` + **register** with the consumer HID *usage* | register |
| 33–41 (shortcuts, macro, keys) | byte `0x3e`/`0x3f` + **register** with modifier + key | register |

### Functions with a single byte (measured one by one)

| id | function | code | id | function | code |
|---|---|---|---|---|---|
| 1 | Left Button | `0x21` | 12 | Show Desktop | `0x27` |
| 2 | Mid Button | `0x22` | 13 | Double click | `0x28` |
| 3 | Right Button | `0x23` | 14 | Autofire (burst) | `0x29` |
| 4 | Backward | `0x24` | 15 | LED Loop | `0x35` |
| 5 | Forward | `0x25` | 16 | DPI + | `0x2b` |
| 6 | DPI Loop | `0x26` | 17 | DPI − | `0x2c` |
| 19 | Office | `0x37` | 18 | Fn function | `0x34` |
| 20 | Game I | `0x38` | 21 | Game II | `0x39` |
| 22 | Game III | `0x3a` | | | |

Ids 7–11 (`Extend`, `Media`, `Macro`, `ShortCut`, `Mode`) are **menu
categories**, not functions: when you pick them the tool stores the specific sub-function.

### Multimedia keys (byte `0x2f` + consumer HID usage)

9-byte register starting at `0x186`:

```
01 00 ff <usage_lo> <usage_hi> 90 04 00 8a
```

| id | function | usage | id | function | usage |
|---|---|---|---|---|---|
| 23 | Browser | `0x0223` | 28 | Previous | `0x00b6` |
| 24 | Player | `0x0183` | 29 | Next | `0x00b5` |
| 25 | Mail | `0x018a` | 30 | Mute | `0x00e2` |
| 26 | Vol + | `0x00e9` | 31 | Play/Pause | `0x00cd` |
| 27 | Vol − | `0x00ea` | 32 | Calculator | `0x0192` |

They are standard *consumer usages* of page `0x0C`, and the mouse **has** that
collection (`input 2`), so these functions are executed by the firmware: they should
work without the vendor application.

**Slots of the active profile** (measured button by button; they follow the physical order, not
the order of the list):

| button (index) | byte addr. | register slot | button (index) | addr. | slot |
|---|---|---|---|---|---|
| 0 | `0x08` | `0x0A0` | 5 | `0x0D` | `0x0D2` |
| 1 | `0x0A` | `0x0B4` | 6 | `0x3B` | `0x0FA` |
| 2 | `0x09` | `0x0AA` | 7 | `0x3C` | `0x104` |
| 3 | `0x0C` | `0x0C8` | 8 | `0x0F` | `0x0E6` |
| 4 | `0x0B` | `0x0BE` | 9 | `0x0E` | `0x0DC` |

Going back to a normal function is equivalent to writing the 1-byte code and zeroing
the 9 bytes of the register. The configurator already does it that way.

> Unresolved: when assigning multimedia to buttons 0 and 1 the tool also writes
> a **second register** of 9 bytes (`01 00 ff 00 00 00 00 00 0a`) at
> `0x02BC` and `0x02C6`; with buttons 2–9 it does not. We do not know what it means or
> whether the mouse needs it, so we do not replicate it. If a multimedia key does not
> work on the hardware, that is the first candidate.

### Shortcuts, keys and macros (byte `0x3e`/`0x3f` + register)

9-byte register, same fields but with `0x187` as the modifier byte:

```
01 04 ff <key_lo> <key_hi> 90 04 00 8a
```

Measured example: id 33 `Copy` → `01 04 ff b7 00 …`.

Ids 50, 51, 52, 53 and 259 that the factory `config.ini` carries are custom
actions of this group. Their registers are:

| id | register |
|---|---|
| 50 | `01 8c ff 00 00 20 04 00 82` |
| 51 | `01 89 ff 00 00 00 04 00 84` |
| 52 | `01 8c ff 00 00 50 04 00 90` |
| 53 | `01 82 ff 00 00 80 04 00 8a` |
| 259 | `01 88 ff 00 00 90 04 00 0a` |

Those `0x89`, `0x8c`, `0x82`, `0x88` values were first read as **HID modifier masks**; they are
not. They are the type byte of §5-ter (the flow's word count, `0x80 | words`) and the `0x04xx` is
the absolute address of the flow, so these five registers are the shared record pool that macros use
too, and ids 50–53/259 are the factory's own library entries rather than shortcuts.

The shortcut captures of this group write `01 00` + four (opcode, usage) pairs at the register in
`0x186`: `Ctrl+C` → `ef ad 13 0a`, `Ctrl+A` → `cc a8 0e 0a`, `Win+E` → `dd be 03 0a`. The opcodes
change with the shortcut and the rule behind them has not been found, so a new shortcut still cannot
be synthesised (§6).

**Unresolved:** how the registers are distributed when several buttons use advanced functions (the
pointer table at `0x006E` changes base: `0x0490`, `0x04a8`, `0x0460`…) and where the key and the
modifier of a shortcut come from (the tool has a "Please enter the key" dialogue).

> The mouse descriptor **has no keyboard collection** (only mouse `0xFF00`, configuration `0xFF01`
> and consumer `0x0C`) and the vendor's EXE does not import `SendInput`/`keybd_event`, yet a key
> assigned to a button does reach the OS **with the vendor tool closed** — that is what the hold in
> §5-ter proves. So the firmware sends it itself, through the vendor collection.

## 5-ter. Macros and keys: the macro area

Macro contents **are uploaded to the mouse** on every Apply: the `0x0400` block of the image
carries the step flow and it matches what the editor shows. `constMacro.dat` (§5-quinquies) is
only the PC-side library the vendor tool fills that block from.

### Layout: a 192 B arena, then the macro library

| range | contents |
|---|---|
| `0x0400–0x04BF` | **arena**: flows of the buttons that carry a key or a macro (192 B) |
| `0x04C0–0x0567` | **macro library**: the flows that belong to no button (168 B) |
| `0x014A`, `0x0154`, `0x0168`, `0x0172`, `0x0186` | the library's five records, 10 B each, same shape as a button slot |
| `0x006E` (×4), `0x0079`, `0x007B`, `0x0203`, `0x028F` | "next free" pointers of the library |

The factory image (`web/default_image.js`, rebuilt from `tools/probe/baseline.log`) keeps the
library **in `0x0400`** — inside the arena — and everything that addresses it sits with it. That
is the trap that cost two sessions: writing a key at `0x0400` overwrites the library while its
five records still point there, so the firmware resolves the button's flow against the library and
runs the wrong one. The vendor tool shifts library **and** records by `+0xC0`
(`LIB_BASE 0x04C0 − STREAM_BASE 0x0400`) when it allocates the first button flow;
`liftLibrary()` in `web/core.js` does the same at the start of every `applyEdits` and is
idempotent (if the records already sit at `0x04C0` or above, it touches nothing). A capture of a
configuration that holds keys has the records at `0x04C0`/`0x04E0`/`0x0510`/`0x0540`/`0x0550` and
the pointers at `0x0568`…`0x0588`.

### The slot record (10 bytes)

| byte | meaning |
|---|---|
| 0 | `0x01` |
| 1 | type: **number of steps** (Repeat On, until click) or **`0x80 \| words`** (until release) |
| 2 | `0xFF` |
| 3–4 | parameter: consumer usage in multimedia records, `0x0000` in macros |
| 5–6 | **address of the flow, uint16 little-endian, absolute** (`0x0400` + offset) |
| 7 | `0x04`, the same for all three repeat modes |
| 8–9 | length; `0x000A` in every record the configurator writes |

The first builds of the configurator put the offset in bytes 3–4, so the firmware read `0` in
every record and **every button played the first flow** (four buttons with W, Shift, O and I all
typed `W`); those images are still read through a fallback. Bytes 5–6 are an absolute address, not
"offset plus a fixed `0x04`": the `0x04` is the high byte of `0x04xx`. The library records, which
live above `0x0500`, carry `0x0510`, `0x0540`, `0x0550`.

### Flow formats

A flow starts with a **uint16 repeat count** (only `Repeat On` uses it; the other modes write `1`)
followed by variable-length elements:

| bytes | meaning |
|---|---|
| `83 <usage> <delay> <usage> 00 00` | key tap, 6 B, carries its own release (`85` appears in the vendor's `first aid` and is accepted when reading) |
| `83 <usage>` / `82 <usage>` | key down / key up, 2 B each |
| `81 <code>` / `01 <code>` | mouse button down / up, `f1`/`f2`/`f3` = left/middle/right |
| `01 f6 <x16> <y16>` | move, signed int16 |
| `81 f8 <dpi/200>` / `01 f8 <dpi/200>` | DPI set / restore |
| `01 f9 <…>` | LED step (payload not decoded, read-only in the configurator) |
| `00 <ms/2> 00` | delay in 2 ms units (`00 01 00` = 2 ms) |

Keys are **HID usages** (`0x04` A, `0x14` Q, `0x1A` W, `0xE1` LShift). The vendor's `.dat` stores
Windows virtual-key codes and converts them when it uploads the flow (§5-quinquies).

The type byte is **decoded**: bit 7 marks the run-until-release family and the low seven bits are
the number of 2-byte words of the flow body — the flow length is stored nowhere else, so that is
how the firmware knows where it ends. Twelve captures agree: 20 `81 <usage>` words → `0x94`, a
54-byte nine-tap macro → `0x9b`, 13 down/up pairs → `0x9a`. A declared word count that does not
match the flow makes the firmware misread it.

### The three ways to put a key on a button — all measured on the mouse

| mode in the UI | what is written | size | behaviour |
|---|---|---|---|
| **hold while pressed** (default) | action `0x2E`, slot `01 94 ff 00 00 <addr> 04 00 0A 00`, flow `01 00` + 20× `81 <usage>` | 42 B | **holds**: the key goes down when the button is pressed — with the system's auto-repeat, like a real key — and comes up when it is released |
| **tap once** | action `0x2D`, slot type `0x02`, flow `01 00 83 <usage> <delay> <usage> 00 00` (the vendor's `map` macro) | 8 B | one tap per press; it carries its own release, so it can never stick |
| **tap while held** | action `0x2D`, slot type `0x80 \| 2·pairs`, flow `01 00` + pairs of `81 <usage> 01 <usage>` (the `tap_q` capture) | 2 + 4·pairs | taps while the button is held; each pair releases before the next one |

The hold is the vendor's own shape — twenty copies **and** `0x2E` is exactly what the `kd_shift`
and `kd_q` captures carry — and it only works once the library is out of the arena (above).
Capacity inside the 192 B arena, with the 8-byte alignment the firmware expects:

| mode | bytes per key | keys that fit |
|---|---|---|
| hold | 42 | **4** |
| tap once | 8 | 24 (the mouse only has 10 buttons, so all of them) |
| tap while held | 2 + 4·pairs (18 with 4 pairs, padded to 24) | 8 |

Macros share that arena with the keys, so the limit is bytes and not steps: a macro takes
`2 B + its steps` (padded to 8), i.e. a 21-step tap macro is 128 B and leaves room for one held key
(42 B) and nothing else. A flow that does not fit is not written: the button keeps its previous
action and the table shows `No room for button N…`; the Macros tab prints how much of the 192 B is
in use.

### The action byte says what it launches, not how it repeats

`0x2D` is the **inline** macro (the path the vendor's `Convert K1 to a macro` takes, into the
button's own block) and `0x2E` the **library** macro; the disassembly has exactly two sites writing
them (`0x534797` → `0x2E`, and `0x53478E` → `0x2F` for multimedia). Assigning the same `mirror`
macro with modes `01` and `02` wrote byte-identical action and slot
(`01 82 ff 00 00 10 04 00 0A 00`), and mode `00` wrote `0x2D`: the difference is the assignment
path (library vs inline), not the mode. Slot byte 7 does not change with the mode either — the
`0x84` that earlier notes read as "Run until click" is byte 8 of the record. Where the mode lives
inside the macro is still open: it is `0x3C` in the `.dat`, and the on-mouse copy of that header
has not been located.

Multi-step macros are the same arena record. The vendor moves its own arena content by exactly 8
bytes per inserted macro, so **every flow starts on an 8-byte boundary**; a flow on an unaligned
offset resolves to the wrong record (that, together with the offset byte, is what kept "every macro
button plays the first flow" alive). The configurator writes key taps, mouse buttons, XY movement,
DPI set/restore and delays, up to 21 steps (`MAX_STEPS`), and leaves the LED step read-only because
its payload is not decoded.

## 5-quater. LED: the fourteen effects, measured one by one

Measured by driving the vendor tool under Wine: pick an effect (or move one of its
controls) in its UI, press Apply, and read the image it writes. The tool also saves the
`config.ini` it applied, which names every field it moved. Instruments:
`tools/probe/led_capture.py` (screenshot + full image per dropdown entry),
`tools/probe/led_cases.py` (a list of UI actions, one Apply each) and
`tools/probe/led_sweep.py` (one `config.ini` field at a time).

| byte | content |
|---|---|
| `0x1C` | high nibble = effect id; low nibble = cycle speed (`LED_CYCTIME`, 0–7) |
| `0x33` | bit `0x80` = the vendor's **second group of names**; the low bits (`0x3F`) stay as they were |
| `0x1D` | `0x80 \| CYC_7COL_EN`: one bit per colour, the ones that enter the cycle |
| `0x20–0x31` | **six pairs**: high nibble = `LED_USER0…5` (user colour), low = `DPI0…5` (stage colour) |
| `0x3A` | bit `0x40` = symmetry; bits `0x10`/`0x20` = direction (0 clockwise, 1 inverse, 2 two way, 3 magicalady) |
| `0x3E` | high nibble = `LED_USER6_R`, low nibble = `LED_USER6_G` |
| `0x3F` | high nibble = `LED_BRIGHT` (0–15); low nibble = `LED_USER6_B` |

### The fourteen effects and what each one writes

The dropdown has **14** entries and its value is `LED_TYPE` in `config.ini` (0–13). The
tool writes the high nibble of `0x1C` as `8 + (LED_TYPE mod 8)`, so the first eight names
cover ids 8–15 — but the second group of names is *not* a duplicate: for `LED_TYPE` 8–11
the tool also sets bit 7 of `0x33`, and that is a different animation. `Button response`
(12) and `Mute` (13) both keep id 9 and encode themselves in the **cycle nibble**, the
only place the tool writes a value outside 0–7.

| entry | `LED_TYPE` | `0x1C` | `0x33` | controls the tool shows |
|---|---|---|---|---|
| Breathing | 0 | `8n` | `3F` | speed |
| Cycle breath | 1 | `9n` | `3F` | speed, 7 colours + ticks |
| Constantly | 2 | `An` | `3F` | brightness |
| Flow water | 3 | `Bn` | `3F` | speed, brightness, colours, symmetry, 4 directions |
| Single water | 4 | `Cn` | `3F` | speed, brightness, colours, symmetry, 3 directions |
| Comet tail | 5 | `Dn` | `3F` | speed, brightness, colours, symmetry, 3 directions |
| Neon | 6 | `En` | `3F` | speed |
| Ambilight | 7 | `Fn` | `3F` | speed, symmetry, 2 directions |
| Flicker | 8 | `8n` | `BF` | speed |
| Star Trek | 9 | `9n` | `BF` | — |
| Water | 10 | `An` | `BF` | speed, 2 directions |
| enraptured | 11 | `Bn` | `BF` | speed |
| Button response | 12 | `9C` | `3F` | one animation per button (§ below) |
| Mute | 13 | `97` | `3F` | — |

`n` = the cycle speed (0–7). The sixteen option combinations were measured one effect at a
time and every control writes the same `config.ini` field whatever is on screen: the speed
slider moves `LED_CYCTIME` **and** `LED_CYC_TIME`, the brightness slider moves
`LED_BRIGHT`, the seven ticks move `CYC_7COL_EN`, symmetry moves `LED_FEATURE_SYMMETRY`
and the direction radios move `LED_FEATURE_DIREC` (0/1/2/3 → `0x3A` bits 4–5). Nothing in
the image is per-effect: the effect is the id, the options are the shared LED block.

The vendor sliders do not use the whole nibble: dragging the **brightness** slider from its
right end to its left end gives `LED_BRIGHT` 0 → 6 (0 is the factory value and it is the one
that lights the mouse at full level), and the **speed** slider gives 0 → 5. The firmware
field is a 4-bit nibble, so the configurator offers 0–15 and 0–7.

**The level is inverted.** The LED is active-low: the byte stores the channel's
"darkness" and lights with `15 − value`. The channel is in its place
(`0x20` R, `0x21` G, `0x22` B and in the 7th colour `0x3E` high R, `0x3E` low G,
`0x3F` low B); what is reversed is the level. Measured on the mouse, writing pure triples:

| written | seen |
|---|---|
| `(15,0,0)` | `(0,255,255)` cyan |
| `(0,15,15)` | `(255,0,0)` red |
| `(15,0,15)` | `(0,255,0)` green |

So: to paint red you have to store `(0,15,15)`. The vendor `config.ini` does not apply that
inversion, so its values are not the colour that comes out; the configurator does it in
`web/core.js` (`lit()`), and the rest of the UI keeps talking about normal `{r,g,b}`.

Unconfirmed: whether the **brightness** (`0x3F` high) is inverted as well. With the
brightness at 0 from factory the mouse lights up, so either it is not inverted or 0 means
"no attenuation"; the configurator writes it as is until we know.

The channels are **4 bits (0–15)**, as in `config.ini`. Cross-checked colour by colour with
the factory configuration: the seven `LED_USER*` and the six `DPI*` come out exactly as
they are in the ini, and `CYC_7COL_EN=127` with the seven bits set. Changing the brightness
from 0 to 1 moves only `0x3F` (`0x00→0x10`), and from 0 to 7 puts it at `0x70`; changing a
colour moves **only** its byte, in the nibble that corresponds to it.

**What the mouse does.** Watching the LED and writing each value of the high nibble on the
factory image (`0x33 = 0xBF`, i.e. the *second* group): id 8 blinks nervously, 9 holds a
fixed colour, 10 breathes but with its own colours, 11 chases like "Star Trek", and
12–15 light nothing. That table is where "the vendor's names are fiction" came from in
earlier versions of this document; now that ids 8–11 exist **twice**, the honest reading is
that the names of the second group (Flicker, Star Trek, Water, enraptured) were measured and
the first group was not, so the animations of `Breathing`…`Ambilight` (bank 0) and of the
ids 12–15 are **not yet observed on hardware**. The Debug tab's byte probe is the way to
close it.

### Button response: one animation per button

The four animations are the tool's own list — the strings are in its `.exe`:
«1.Cycle breath 2.Flow water 3.Comet tail 4.Single water». They are not in the LED block:
each button's **action byte** (`0x0008–0x000F`, `0x003B–0x003C`) carries them in its top
bits, next to the action:

```
bits 7-6   animation: 0 Cycle breath, 1 Flow water, 2 Comet tail, 3 Single water
bit  5     react enabled (the ini's LED_REACT_EN; 1 in the factory image)
bits 4-0   the action itself (0x21 = Left, 0x27 = Show Desktop, …)
```

Measured one button at a time, `LED_REACT_TYPE<i>` = 1 → the byte grows by `0x40`
(`tools/probe/react_map.py`, `react_sweep.py`):

| `LED_REACT_<i>` | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| byte | `0x08` | `0x0A` | `0x09` | `0x0C` | `0x0B` | `0x0D` | `0x3B` | `0x3C` | `0x0F` | `0x0E` | — | — |

(index 0 = Left, 1 = Right, 2 = Middle, 3 = Forward, 4 = Backward, then the model's own
buttons; 10 and 11 are written nowhere). `LED_REACT_EN<i> = 0` clears bit 5 of that same
byte — `0x21` (Left) → `0x01` — which is what an "off" animation looks like, and the reason
the configurator calls it out: it is the vendor's own encoding, and it is **not verified on
hardware** whether the button keeps working with bit 5 clear.

Because the animation shares the byte with the action, a write to one must not clobber the
other: `web/core.js` preserves bits 7–6 when an action is written and bits 4–0 when the
animation is.

### Driving the vendor tool under Wine (harness)

The captures behind §5-bis to §5-quinquies come from the vendor EXE running under Wine with
`tools/hid_shim.c` impersonating `HID/SetupAPI`. Recipe for one pass:

```bash
docker exec g6re-run bash /work/tools/probe/ui.sh start     # starts the app
docker exec g6re-run bash /work/tools/probe/ui.sh click 371 212   # Macro tab
docker exec g6re-run bash /work/tools/probe/ui.sh shot paso1
docker exec g6re-run bash /work/tools/probe/ui.sh save mi_captura
```

Note: the Apply button only responds if the cursor is moved over it first
(`move 853 850` and then `click 853 850`), and the macro recorder does not capture
synthetic keys from `xdotool`; you have to use Insert → "Please enter the key".

## 5-quinquies. The macro library file (`constMacro.dat`, `PUBG3 V6.48.dat`)

The tool's macros live in an ini-shaped text file that ships next to the EXE
(`/app/constMacro.dat`). It is the *PC* copy: `DAT_VER=3`, `macroNum=N` and one line per
macro, `<index>=<bytes>`, where **every byte is written as three decimal digits**
(`109000105000`… = `6D 00 69 00 50 00`…). Each record is 2621 bytes:

| bytes | content |
|---|---|
| `0x00–0x3B` | name, UTF-16LE, 30 characters (`mirror`, `first aid`, `一刀毙命`…) |
| `0x3C` | repeat mode: `00` = Repeat On, `02` = Run until release (measured) |
| `0x3F` | **number of steps** (`02` in `mirror`, `08` in `DPI Shift`, `03` and `01` in the sample below) |
| `0x3D`–`0x50` | flags: `0x3D` = `01` and `0x4C` = `0A` in *every* record measured, `0x45` = `01` only in the macro that changes DPI. Undecoded |
| `0x51` on | steps, **8 bytes each**: `01 <key> 00 00 00 00 <delay_lo> <delay_hi>` |

The two sections are **not in a fixed order**: `PUBG3 V6.48.dat` starts with `[Macros]` and
ends with `[Init]`/`DAT_VER=3`, while an export of macros written by the tool puts `[Init]`
first. Parse by key name, never by line position.

Step types seen in the vendor's own files: `01` = key down, `02` = key up, `00` = delay,
`09` = DPI change. The key field holds a **Windows virtual-key code**, not a HID usage
(`0xA0` LShift, `0x57` W, `0x4D` M, `0x38` `8`, `0x4F` O, `0xF1` right button = the `R-KEY`
the tool prints); the tool converts VK → HID usage when it uploads the flow. The delay is
**per step**, 16-bit little endian in milliseconds; a `00` step is a bare delay and carries
nothing but that number. A release step (`02`) is written for the mouse buttons but **not**
for the keyboard keys the tool wrote, so where those get released is still unknown.

Checked against what the vendor UI shows for that file (Macro tab, tree `PUBG3 V6.48`):

| macro | UI rows | bytes |
|---|---|---|
| mirror | R-KEY 30 ms, R-KEY 1 ms | `01 f1 … 1e 00`, `02 f1 … 01 00` |
| run | LSHIFT 20 ms, W 4104 ms | `01 a0 … 14 00`, `01 57 … 08 10` |
| map | M 10 ms, M 30 ms | `01 4d … 0a 00`, `02 4d … 1e 00` |
| first aid | 8 10 ms, 8 20 ms | `01 38 … 0a 00`, `02 38 … 14 00` |
| DPI Shift | R-KEY 10, R-KEY 10, DPI:400 254, four delays | `01 f1`, `02 f1`, `09 f8 02 … fe 00`, then `00` steps |

The app only lists `macroNum` entries (the file above carries 7 but shows 5).

A third sample, exported by the tool after creating two macros in an empty library
(`macro.dat`, `macroNum=2`, `[Init]` first): `w` = key W, a 1 ms delay row, key O, and `o` =
key O alone. The bytes are exactly the format above and fix two things that were guesses:

| macro | `0x3F` | steps from `0x51` |
|---|---|---|
| w | `03` | `01 57 00 00 00 00 01 00` · `00 00 00 00 00 00 01 00` · `01 4f 00 00 00 00 01 00` |
| o | `01` | `01 4f 00 00 00 00 01 00` |

So a multi-step key macro written by the tool is just N steps of 8 bytes, the delay row is a
`00` step with nothing but its delay, and **each step carries its own delay** (the tool
stamped 1 ms on all of them, the single-key macro included). `0x3F` == step count is
confirmed by every record measured so far (here `03`/`01`, `02` in `mirror`, `08` in
`DPI Shift`).

**Creating a key macro in the vendor app.** *Insert* only offers `Insert XY`, `Insert CPI`,
`Insert LED`, `Insert (delay)` and `Insert before/after item`, and that submenu lists just
**Left / Mid / Right button**: there is no keyboard entry, which is what makes the editor
look like it cannot add keys. Keys arrive through the **recorder**, and the recorder does
work — the `w`/`o` file above was recorded with it in the tool; what it ignores is synthetic
keys driven from `xdotool` under Wine (`tools/probe/ui.sh`), which is why the "Please enter
the key" dialogue never showed up in the automated captures. Existing key steps can also be
re-pointed at another key from that same list. The configurator has no such limit: its
Macros tab creates steps with any key plus a delay.

## 6. What remains open

* **DPI code → real dpi** correspondence (measure on the mouse).
* Where the **repeat mode** (Repeat On / until click / until release) is stored *on the mouse*: it
  is `0x3C` in the `.dat` and the action byte does not carry it (§5-ter), but the on-mouse copy of
  that header has not been located. Related: what the `01` flags at `0x40`/`0x44`/`0x48` of the
  `.dat` records (present in the macros that carry XY/LED/CPI steps) mean.
* The **LED step** payload (`01 f9 …`): the vendor writes it from its global configuration and it
  is not decoded, so the macro editor leaves it read-only.
* The **shortcut opcodes** of the `0x3e`/`0x3f` group (§5-bis): `Ctrl+C` → `ef ad 13 0a`, `Ctrl+A`
  → `cc a8 0e 0a`, `Win+E` → `dd be 03 0a`; the rule behind them has not been found, so a new
  shortcut cannot be synthesised from the UI yet.
* Encoding of **LED colours** per stage, `WHEEL_SPEED` and `DPI_SPEED` (increments of
  1 change no byte: either they are quantised or they live in the registers).
  `LED_CYC_TIME` alone changes nothing either: the tool writes it **together with**
  `LED_CYCTIME` and the image takes the second (`0x1C`, low nibble).
* Semantics of multi-byte reading (index as offset).
* Whether `0x0080–0x009F` is unused profile 3/4 storage.

## 7. How to keep investigating

```bash
# Wine image ready for the EXE + the shim
docker build -f tools/Dockerfile.wine -t g6re:local .
docker run -d --name g6re-run -v "$PWD":/work -w /work g6re:local sleep infinity

# one pass: starts, presses OK, saves the traffic to tools/probe/<name>.log
docker exec g6re-run bash /work/tools/probe/probe.sh baseline

# change one field and see which bytes change
python3 tools/probe/sweep.py Config0.K0 ShareData.DPI_SET0

# drive the vendor UI: one Apply per case, plus the config.ini it saved
python3 tools/probe/led_cases.py tools/probe/cases_fw.json
# screenshot + full image for every entry of the lighting dropdown
python3 tools/probe/led_capture.py
# per-button "button response": which byte each LED_REACT_TYPE moves
python3 tools/probe/react_map.py

# rebuild the memory the program wrote
python3 tools/probe/parse_log.py tools/probe/baseline.log --mem
```

On real hardware, the first thing is to confirm reading:
`python3 tools/g6cli.py dump` (it saves a backup) and compare with what the
vendor program writes for the same configuration.
