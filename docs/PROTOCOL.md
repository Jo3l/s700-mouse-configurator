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
| API used | `HidD_SetFeature` / `HidD_GetFeature` on a `CreateFile(..., GENERIC_READ|GENERIC_WRITE)` handle |

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
image — the 108 blocks of `WRITE_BLOCKS`, in the same order the
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
| `0x006E–0x007F` | table of pointers to registers + checksum (changes with the actions) |
| `0x00A0–0x02CF` | advanced action / macro registers (not deciphered) |
| `0x0400–0x04A7` | more registers and a flags block |
| `0x0080–0x009F` | **not** written with the default configuration (unused profiles?) |

The program **always writes** `0x0001`, `0x006E` (2 bytes) and the 15 blocks from
`0x0008` to `0x007F`, plus `0x00A0–0x02CF` and `0x0400–0x04A7`. It never writes
`0x0080–0x009F` in profile 1.

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

The values `0x89`, `0x8c`, `0x82`, `0x88`, `0x8a`, `0x84` fit suspiciously well
with **HID modifier masks** (`0x01` Ctrl, `0x02` Shift, `0x04` Alt,
`0x08` Win, `0x80` "there is a modifier"), so the key and modifier fields
are there even though we still do not know in what order. That implies that **assigning Shift
(or Ctrl+C) to a button is representable**; confirming the exact split of
fields and who executes the key is still pending.

**Unresolved:** where exactly the key and the modifier come from (the
tool has a "Please enter the key" dialogue), how the
registers are distributed when several buttons use advanced functions (the pointer table at
`0x006E` changes base: `0x0490`, `0x04a8`, `0x0460`…) and whether the mouse executes those
keys itself.

> Important detail: the mouse descriptor **has no keyboard collection**
> (only mouse `0xFF00`, configuration `0xFF01` and consumer `0x0C`), and the vendor's EXE does not import
> `SendInput` or `keybd_event`. Either the keys of this group
> are sent by the firmware through a path we do not see, or they depend on the
> application being open. It takes 2 minutes to check: assign `Copy` to a button,
> **fully close** the vendor application and press the button in
> Notepad.

## 5-ter. Macros: yes, they are stored on the mouse

Contrary to what it seemed at first, **the macro contents are uploaded to the mouse**
on every Apply: the `0x0400–0x04A7` block of the dump contains the step flow, and
it matches what the editor shows. `constMacro.dat` is only the PC copy
(8 macros), the source from which that block is filled.

Assigning by hand (Macro tab → choose macro → Insert → Apply) the
"first aid" macro (key `8`, 10 ms, key `8`, 20 ms) to button 10, the vendor wrote:

| byte | value | meaning |
|---|---|---|
| `0x0E` (button 10) | `0x2D` | **action = macro** (multimedia was `0x2F`, basic `0x21–0x3A`) |
| `0xDC` (its slot) | `01 02 ff 00 00 00 04 00 0A 00` | type `02` = macro, `00 00` = offset in the block, `0A 00` = length (10 bytes) |
| `0x400` | `01 00 85 25 0A 25 00 00 01 00` | the 10 bytes of the macro flow |

Inside the flow **HID keyboard usages** appear: `0x25` is key `8` (`0x1E`
= `1`, `0x1F` = `2`… `0x26` = `9`), which is exactly the key of that macro. So
the mouse stores keys as HID usages, and a button can execute them without the
vendor application.

The macro editor also supports steps of type XY (movement), CPI (DPI
change), LED and delays, and repeat options ("Run Until release", "Run Until
Click", "Repeat On = N").

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

### How the web configurator uses it

`web/core.js` encodes a macro as **10 bytes per step** (`01 00 83 <usage>
<delay> <usage> 00 00 01 00`), the same shape as the capture of one vendor
step, and assigns it to the button with `0x2D` + the register of the slot. The byte
`0x83` is the one from the "map" capture; in "first aid" the vendor put `0x85`, so
that byte remains open: **macros of more than one step are an extrapolation
and are not tested on the mouse**. The editor limits to 16 steps (168 B from `0x400`,
the whole block) and does not write a flow that does not fit.

### What is missing to "assign a key directly"

The 10-byte "first aid" flow encodes **two** key steps in 10 bytes, so
each step takes ~5 bytes (usage + delay + flags), but with a single sample the
exact split cannot be fixed. Plan to close it:

1. Create three single-step macros in the tool (key `A`, `Shift` alone,
   `Ctrl+C`) with the "Please enter the key" dialogue.
2. Apply and dump: each flow will have 5 bytes and the usage will say which field is which.
3. With that, "assign key" = write a 5-10 byte flow + the register
   `01 02 ff…` + the byte `0x2D` on the button. The interface can show it as
   "Key: Shift" without the user seeing macros.

Recipe for driving the tool under Wine (needed for those dumps):

```bash
docker exec g6re-run bash /work/tools/probe/ui.sh start     # starts the app
docker exec g6re-run bash /work/tools/probe/ui.sh click 371 212   # Macro tab
docker exec g6re-run bash /work/tools/probe/ui.sh shot paso1
docker exec g6re-run bash /work/tools/probe/ui.sh save mi_captura
```

Note: the Apply button only responds if the cursor is moved over it first
(`move 853 850` and then `click 853 850`), and the macro recorder does not capture
synthetic keys from `xdotool`; you have to use Insert → "Please enter the key".

## 6. What remains open

* **DPI code → real dpi** correspondence (measure on the mouse).
* Distribution/allocation of the **advanced action registers** (`0x0490`, `0x04a8`,
  `0x0460`… depending on which buttons use them).
* Format of the **advanced action and macro registers** (`0x00A0–0x02CF`,
  `0x0400–0x04A7`): they are generated when picking actions ≥21 and contain the pointers of
  `0x006E`. Not deciphered.
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
