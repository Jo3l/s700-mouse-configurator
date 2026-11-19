#!/usr/bin/env python3
"""Map button -> 'Button response' byte: one run per button with
LED_REACT_TYPE_i=1 and a diff against the base (same LED_TYPE, react untouched)."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))

def base(mode=12):
    return exp.set_vals(exp.load(), "ShareData", LED_TYPE=mode)

def run(name, text):
    exp.save(text)
    exp.run(name)
    return memory(parse(os.path.join(HERE, name + ".log")))

b12 = run("rm_base", base(12))
print("base 0x00-0x20:", " ".join("%02x" % b12.get(a, 0) for a in range(0x00, 0x21)), flush=True)

for i in range(12):
    m = run("rm_b%02d" % i, exp.set_vals(base(12), "Config0", **{"LED_REACT_TYPE%d" % i: 1}))
    ch = {hex(a): (b12.get(a), m.get(a)) for a in sorted(set(b12) | set(m)) if b12.get(a) != m.get(a)}
    print("button %2d -> %s" % (i, ch), flush=True)

b8 = run("rm_base8", base(8))
m = run("rm_b00_8", exp.set_vals(base(8), "Config0", LED_REACT_TYPE0=1))
ch = {hex(a): (b8.get(a), m.get(a)) for a in sorted(set(b8) | set(m)) if b8.get(a) != m.get(a)}
print("mode 8 + type0=1 ->", ch, flush=True)
