# Native host: the same configurator without browser permissions

The configurator is a page that speaks WebHID. That has two drawbacks that are
not the project's:

1. The browser asks for permission **per origin** for each device, and on Linux
   the `/dev/hidraw*` node belongs to root, so a udev rule is needed anyway.
2. It only works in browsers with WebHID (Chrome, Edge, Brave…), and from
   `file://` not even that.

`native/` is a small binary (one window, no installer) that does the same but
with no browser in between: it serves the UI from inside itself on `127.0.0.1`,
shows it in its own window with the system WebView — WebView2 on Windows,
WebKitGTK on Linux — and speaks HID itself.

```
make native        # native/target/release/s700-host (~1.3 MB)
make native-run    # builds it and opens the window

# Linux builds need the WebKitGTK headers once (runtime needs the .so):
sudo apt install pkg-config libwebkit2gtk-4.1-dev libgtk-3-dev
```

```
s700-host [--port N] [--no-open] [--browser] [--list]

  --port N    local port (8760 by default). Pin it: the browser stores
              changes per origin, so changing port is changing
              storage.
  --no-open   do not open anything
  --browser   open the UI as a normal tab in the default browser instead of
              its own window
  --list      list the mouse interfaces and exit
```

## The three ways to use the same project

| | Permissions | Depends on | Size |
|---|---|---|---|
| `make serve` + Chrome | WebHID dialog + udev rule on Linux | a browser with WebHID | 0 |
| `dist/S700-configurador.html` | same (it opens as `file://`) | same | ~520 KB |
| `make native` | **nothing on Windows**; udev on Linux | Windows: nothing (WebView2 ships with Edge). Linux: `libwebkit2gtk-4.1-0` + `libgtk-3-0` | ~1.3 MB |

All three serve the same UI: `web/` is not duplicated or adapted.

## One file for Linux (AppImage)

```
make appimage      # dist/S700-configurator-x86_64.AppImage (~80 MB)
```

`native/build-appimage.sh` builds it inside `ubuntu:22.04` and bundles WebKitGTK,
its injected bundle, the GTK/GLib stack and the X11 libraries with `linuxdeploy`.
Two details are what make it work:

- **WebKitGTK has no relocation variable**: the directory of its helper processes
  (`WebKitWebProcess`, `WebKitNetworkProcess`, `WebKitGPUProcess`) is compiled in
  as an absolute path. The build rewrites that string to `./usr/lib/webkit2gtk-4.1`
  (same length, NUL-padded) and `AppRun` starts with the AppImage as its working
  directory, so the relative path resolves inside the bundle.
- **GL, fonts and permissions stay on the system**: an AppImage must not ship the
  GPU driver stack, so `libGL`/`libEGL`/`libGLESv2` and the fonts come from the
  desktop (every one has them). The kernel still needs the udev rule for
  `/dev/hidraw*`; the binary offers to install it.

Verified in a bare `ubuntu:22.04` container (no WebKitGTK, no GTK) under Xvfb: the
window opens, the page renders and the mouse is listed by the host.

## How it fits without touching the UI

`web/bridge.js` is a plug: if `window.__S700_API__` exists (only the host sets
it when serving the HTML), it defines a WebHID-compatible `navigator.hid` that,
instead of talking to the browser, does `fetch` against the process. `app.js`,
`g6.js`, `core.js` and `storage.js` never notice — they keep calling
`sendFeatureReport(7, …)` as always.

```
UI (web/*.js)  →  navigator.hid  →  bridge.js  →  HTTP 127.0.0.1  →  hidraw / hid.dll
```

Without `__S700_API__` the file does nothing, so it can also be loaded in
the normal browser with no effect at all.

Host routes: `GET /api/devices`, `GET /api/state`, `POST /api/open`,
`POST /api/send`, `POST /api/recv` (always fails: the firmware does not answer
GetFeature, `docs/PROTOCOL.md` §4).

## Permissions

**Windows**: nothing. The process opens the device like any other file;
if it fails it is usually because the vendor tool or its tray has it
open exclusively.

**Linux**: the kernel exposes `/dev/hidrawN` as `0600 root:root`. Neither Chrome
nor this binary can write without a rule; the binary does **not** bypass that
(it would be a hole, not an improvement). What it does is offer to install the
rule for you, once, with the normal desktop password dialog:

* **from the UI**: the *Debug* tab notices the node is not openable and shows
  **Install udev rule**. The binary asks for your password with `pkexec` and
  writes the rule; from then on everything runs as your user, Chrome included.
* **from a terminal**: `./s700-host --install-rule` (same thing, no window).
* **by hand**, if you prefer to see what it touches:

```
sudo cp native/99-s700-hid.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
# and reconnect the mouse (or restart the session) so logind applies the ACL
```

The state behind that button is `GET /api/permissions`
(`needed`, `root`, `ruleInstalled`, `node`, `writable`), and
`POST /api/install-rule` runs the elevation and returns its log.

**Do not run the server as root.** `sudo ./s700-host` "works" and needs no rule,
but it would leave a local HTTP server able to write to a device running as root,
which is a much bigger hole than a udev rule scoped to one VID:PID. The rule is a
one-time, per-device, per-seat grant; root is forever and for everything.

If you are on a machine with no seat (SSH, no `logind` session), `uaccess` cannot
give you the node: the rule also sets `MODE="0660" GROUP="input"`, so add yourself
to `input` instead (`sudo usermod -aG input $USER`, then log out and back in).

```
$ ./s700-host --list
/dev/hidraw1	30fa:1540	S700 Gaming Mouse
```

Enumeration needs no permissions: it reads `/sys/class/hidraw/*` and keeps the
interfaces whose descriptor declares the *vendor page* `0xFF00` (the configuration
one; the normal mouse one does not declare it). That is why the WebHID dialog
showed two entries with the same VID:PID and here only the right one shows up.

## Building

**Linux** (what has been tested): `make native`, needs only `cargo`. It uses no
crates, so it builds without network (`--offline`).

**Windows**: backends written in `native/src/windows.rs` (`hid.dll` +
`cfgmgr32`), but **not compiled or tested yet** — this machine is Linux
and has no Windows toolchain. To produce the `.exe`:

```
rustup target add x86_64-pc-windows-msvc
cargo build --release --target x86_64-pc-windows-msvc     # on Windows, or
rustup target add x86_64-pc-windows-gnu                    # on Linux with mingw-w64
cargo build --release --target x86_64-pc-windows-gnu
```

It is the same `main.rs` and the same HTTP protocol; the only difference is how
the device is opened (`CreateFileW` + `HidD_SetFeature`).

## What is verified and what is not

Tested here, with the mouse connected to this machine:

- it builds and starts; `--list` finds `/dev/hidraw1 30fa:1540 S700 Gaming Mouse`
  by picking out the right interface among two with the same VID:PID;
- it serves the whole UI and the HTML comes out with the plug injected;
- `/api/devices`, `/api/state` and the errors answer what they should;
- in Chrome, the page loaded from the host has `navigator.hid.__native`,
  Connect enumerates and returns the real node permissions error (`0600 root:root`)
  with the udev rule instruction;
- `node tools/test_bridge.mjs` covers the plug (15 checks): inert without host,
  `getDevices`/`open`/`sendFeatureReport` with the correct HTTP body, and the
  host errors propagated.

Not tested yet:

- **the real write** to the mouse from the binary: this user has no
  permission on `/dev/hidraw1` (0600 root) and there is no root on the machine. It
  is the only stretch left: install the rule and press Apply.
- **Windows**: it compiles in CI (MSVC, WebView2) but it has never been run: neither
the window nor the HID write is verified there.

## Why a system webview and not Electron

The window is `wry` over `tao`: WebView2 (Chromium) on Windows, WebKitGTK on
Linux. Neither engine implements WebHID, which is exactly why the HTTP bridge
exists — the page talks to this process with `fetch`, so the engine only has to
render HTML. That is what makes the window cheap:

- no Electron: ~90–100 MB per platform, and on Linux it still needs the udev rule;
- no Tauri either: same engines plus a config/plugin framework this project does
  not use, and the app is already one binary embedding `web/`;
- cost of the choice: the Linux binary links `libwebkit2gtk-4.1` and `libgtk-3`
  at run time (Windows needs nothing: WebView2 ships with Edge). If the WebView
  cannot be created, the host falls back to an app window of Edge/Chrome, and
  `--browser` opens a normal tab; `--no-open` still serves headless.
