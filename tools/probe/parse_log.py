#!/usr/bin/env python3
"""Parse a hid.log from the Wine shim into commits (addr, data)."""
import re, sys

def parse(path):
    frames = []
    for line in open(path, errors="replace"):
        m = re.match(r"^(SET|GET) ([0-9a-f]+)\s*$", line.strip())
        if m:
            frames.append((m.group(1), bytes.fromhex(m.group(2))))
    commits, stage = [], {}
    for kind, b in frames:
        if kind != "SET" or len(b) < 8:
            continue
        cmd, idx = b[2], b[3]
        addr = b[4] | (b[5] << 8)
        val, ln = b[6], b[7] + 1
        if cmd == 3:
            stage[idx] = val
        elif cmd == 9:
            commits.append((addr, bytes(stage.get(i, 0) for i in range(ln))))
        elif cmd == 0x10:
            commits.append((None, b"END"))
    return commits

def memory(commits):
    mem = {}
    for a, d in commits:
        if a is None:
            continue
        for i, x in enumerate(d):
            mem[a + i] = x
    return mem

if __name__ == "__main__":
    c = parse(sys.argv[1])
    if len(sys.argv) > 2 and sys.argv[2] == "--mem":
        m = memory(c)
        for a in range(0, max(m) + 1, 8):
            print(f"{a:#06x}  " + " ".join(f"{m[a+i]:02x}" if a + i in m else "--" for i in range(8)))
    else:
        for a, d in c:
            print("END" if a is None else f"{a:#06x} {d.hex()}")
