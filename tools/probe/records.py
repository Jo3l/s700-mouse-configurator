#!/usr/bin/env python3
"""Macro record table from the captures: declared type vs real flow.

Why: the type byte of a record `01 <type> ff 00 00 <off> …` carries bit 7
("Run until release") and, in the low seven bits, the number of 2-byte words in
the flow body. That count is the only length the firmware sees, so it has to
match the flow: declaring `0x94` (20 words) over a one-word flow left the key
stuck down forever.

Usage:
    python3 tools/probe/records.py                # every capture in tools/probe
    python3 tools/probe/records.py kd_shift kn7   # only those (no .log)

Verdicts:
    ok      2-byte word flow and the count matches (the measured rule)
    !=      2-byte word flow and the count does NOT match  → bug
    mixed   3/4/6 B steps: the count cannot be measured in bytes (no verdict)
    foreign the flow does not start at `01 00`: the record belongs to the vendor
            macro library and points at another macro's arena
"""
import glob
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse_log as P                      # noqa: E402

BASE, END = 0x400, 0x4a8
# width of each step in the flow (docs/PROTOCOL.md §5-ter): recognised by its header
def step_width(mem, i):
    t, u = mem.get(i, 0), mem.get(i + 1, 0)
    if t in (0x81, 0x01) and u in (0xf1, 0xf2, 0xf3): return 2      # button
    if t in (0x81, 0x01) and u < 0xf0: return 2                      # key down/up
    if t in (0x81, 0x01) and u == 0xf8: return 3                    # CPI
    if t == 0x83: return 6                                          # key tap
    if t == 0x01 and u == 0xf6: return 6                            # XY
    if t == 0x01 and u == 0xf9: return 4                            # LED
    if t == 0x00: return 3                                          # delay
    return 0


def records(mem):
    """Per-button slot records: 01 <type> ff 00 00 <off> 04|84 …

    Only the button slot area (0x80–0xFF). The vendor macro library records live
    higher up (0x14A+) and point at another macro's arena: reading them as if
    they belonged to a button gives false negatives.
    """
    out = []
    for a in sorted(mem):
        if not (0x80 <= a < 0x100):
            continue
        if mem.get(a) != 0x01 or mem.get(a + 2) != 0xff:
            continue
        if mem.get(a + 3) or mem.get(a + 4):
            continue
        if mem.get(a + 6) not in (0x04, 0x84):
            continue
        out.append(a)
    return out


def walk(mem, off):
    """(body bytes, 2-byte words only?) of the flow starting at 0x400+off."""
    i, n = BASE + off, 0
    if mem.get(i) != 0x01 or mem.get(i + 1) != 0x00:
        return None, False
    i += 2
    while i < END:
        if mem.get(i) == 0x00 and mem.get(i + 1) == 0x00:
            break
        w = step_width(mem, i)
        if not w:
            return n, False
        n += w
        i += w
    return n, True


def main(argv):
    here = os.path.dirname(os.path.abspath(__file__))
    files = sorted(glob.glob(os.path.join(here, "*.log"))) if not argv else \
        [os.path.join(here, a + ".log") for a in argv]
    rows, bad = [], 0
    for path in files:
        try:
            mem = P.memory(P.parse(path))
        except Exception:
            continue
        if not mem:
            continue
        for a in records(mem):
            typ, off = mem[a + 1], mem[a + 5]
            mode = "click" if mem[a + 6] & 0x80 else ("release" if typ & 0x80 else "on")
            body, pure = walk(mem, off)
            if body is None:
                verdict, words = "foreign", "-"
            elif not typ & 0x80:
                # without bit 7 the type is the number of STEPS, not words: not judged here
                verdict, words = "", "-"
            elif not pure:
                verdict, words = "mixed", "?"
            else:
                words = body // 2
                verdict = "ok" if (typ & 0x7f) == words else "!="
                bad += 0 if verdict == "ok" else 1
            rows.append((os.path.basename(path)[:-4], hex(a), f"0x{typ:02x}", mode,
                         (typ & 0x7f) if typ & 0x80 else "-", words, verdict))
    seen = set()
    print(f"{'capture':16s} {'record':>8s} {'type':>5s} {'mode':8s} {'declares':>7s} {'flow':>6s}  ")
    for r in rows:
        if r in seen:
            continue
        seen.add(r)
        print(f"{r[0]:16s} {r[1]:>8s} {r[2]:>5s} {r[3]:8s} {str(r[4]):>7s} {str(r[5]):>6s}  {r[6]}")
    print(f"\n{len(seen)} records; {bad} with a count that does not match")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
