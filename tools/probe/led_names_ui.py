#!/usr/bin/env python3
"""Pick each effect IN THE UI and capture the byte the tool writes.

The ini is useless here: the dropdown shows list[LED_TYPE], but on Apply the tool
writes a different number. Here the dropdown is opened and the item picked with a
held click (the skin ignores an instant tap: it needs mousedown, a pause and
mouseup with the pointer already over the item).

    led_names_ui.py 0 1 2 ...      dropdown indices (0 = Breathing)
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "led_names_ui.json")
X = 780              # centre of the open list
Y0 = 409             # first item
STEP = 26            # spacing between items


def sh(*args):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "/work/tools/probe/ui.sh"] + list(args),
                          capture_output=True, text=True)


def raw_xdotool(script):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "-c",
                           "export DISPLAY=:99; " + script], capture_output=True, text=True)


def pick(index):
    exp.save(exp.load())            # always from the same base
    sh("start")
    sh("tap", "530", "200")         # LED tab
    sh("focus")
    sh("tap", "780", "379")         # open the dropdown
    subprocess.run(["sleep", "1"])
    y = Y0 + STEP * index
    raw_xdotool("xdotool mousemove %d %d; sleep 0.5; xdotool mousedown 1; sleep 0.3; xdotool mouseup 1" % (X, y))
    subprocess.run(["sleep", "1.2"])
    sh("shot", "ui_%d" % index)
    sh("tap", "853", "850")         # Apply
    subprocess.run(["sleep", "2"])
    sh("save", "ui_%d" % index)
    sh("stop")
    log = os.path.join(HERE, "ui_%d.log" % index)
    mem = memory(parse(log)) if os.path.exists(log) else {}
    return mem.get(0x1C)


def main(idxs):
    out = json.load(open(OUT)) if os.path.exists(OUT) else {}
    for i in idxs:
        raw = pick(i)
        out[i] = None if raw is None else raw >> 4
        print("index %-2d -> 0x1C=0x%s -> mode %s" % (i, "??" if raw is None else "%02x" % raw, out[i]), flush=True)
        json.dump(out, open(OUT, "w"), indent=1)


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]])
