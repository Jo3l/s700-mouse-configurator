# Debugging the session with the mouse remotely

Disposable scaffolding that serves the web and, at the same time, lets you see
from outside (curl) everything the tab does: HID frames round trip, clicks, memory
read, errors. It is used to diagnose the real mouse when the person who has it in
front of them cannot copy the browser console.

```bash
make debug        # http on :8099 and https on :8443 (forwards to 8099)
```

Open the configurator with `?debug=1`:

```
http://<ip>:8099/web/index.html?debug=1
https://<ip>:8443/web/index.html?debug=1        (self-signed certificate)
https://<host>/proxy/8099/web/index.html?debug=1  (if there is a proxy in front)
```

Without `?debug=1` the page is the usual one and talks to nobody: `web/debug.js`
does not travel in `dist/S700-configurador.html` and no tag loads it — it is
injected by `tools/debugd.py` when serving the page (as `__debug.js`).

The page splits into four tabs: **Configurator** (profiles, buttons with
*Apply to mouse* at the bottom, DPI), **Macros** (macro editor saved in the
browser), **Backup** (export/import the file and what is stored in the
browser) and **Debug** (device diagnostics, memory
dump, HID traffic and the *delay* between blocks). Everything that helps to look
inside lives in Debug: a connection failure switches tab on its own, and `?debug=1`
or `#debug` open it straight away (the hash survives the reload; `#macros` and
`#backup` also work).

## Reading the session

```bash
curl -s localhost:8099/debug/log.txt?n=200     # readable traces (+12.345 out 18 05 …)
curl -s localhost:8099/debug/log.txt?grep=err  # errors only
curl -s localhost:8099/debug/summary           # counters, states, analysed memory
curl -s localhost:8099/debug/state             # last snapshot: memory, config, lastVerify
curl -s localhost:8099/debug/mem               # dump of the memory read
curl -s localhost:8099/debug/hid?n=40&dir=in   # last response frames
```

## Sending orders to the page

```bash
curl -X POST -d 'action=read'    localhost:8099/debug/cmd
curl -X POST -d 'action=apply'   localhost:8099/debug/cmd
curl -X POST -H 'Content-Type: application/json' \
     -d '{"action":"eval","args":{"code":"return s.state.ready"}}' localhost:8099/debug/cmd
curl -s localhost:8099/debug/cmds              # pending and results
```

Actions: `read`, `apply`, `connect`, `connectAll`, `backup`, `click`, `pause`,
`edits`, `clearEdits`, `mem`, `eval`, `reload`. `connect` cannot work
remotely: choosing the device requires a gesture from the user.

## What to look at first

| symptom | where |
|---|---|
| «Failed to open the device» | `log.txt`: the system does not hand over the hidraw (Linux: `/dev/hidrawN` is `root:root 0600`; Windows: the vendor program has it open) |
| reads all zeros | `summary.mem.looks_empty` and `hid.err`; raise the *delay* before re-reading |
| applies but nothing changes | `summary.mem` (was it written to the active profile's block?), `lastVerify.diffs` |
| changes now and reverts after disconnecting | writing only the changed blocks is not enough: suspects `0x006E` (pointer table) and the checksum |

## Habitat for the mouse without a browser (root)

The `/dev/hidrawN` node is `root:root 0600`, so from here the mouse is talked
to inside a container, without sudo:

```bash
docker run --rm --device /dev/hidraw1 -v "$PWD":/work -w /work g6re:local \
  python3 tools/probe/hidraw_probe.py /dev/hidraw1
```

It only does `GET`/`SET` of feature reports: it confirms no blocks, it writes nothing.
