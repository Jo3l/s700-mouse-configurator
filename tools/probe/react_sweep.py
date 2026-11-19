#!/usr/bin/env python3
"""What the tool stores for 'Button response': sweep LED_REACT_* in Config0
with ShareData.LED_TYPE=12 and compare the image, using the same LED_TYPE=12
with react untouched as the base."""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))

def base_text():
    return exp.set_vals(exp.load(), "ShareData", LED_TYPE=12)

CASES = [
    ("r_none", base_text()),
    ("r_t0_1", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE0=1)),
    ("r_t0_2", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE0=2)),
    ("r_t0_3", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE0=3)),
    ("r_t0_4", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE0=4)),
    ("r_en0_0", exp.set_vals(base_text(), "Config0", LED_REACT_EN0=0)),
    ("r_t1_2", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE1=2)),
    ("r_t9_3", exp.set_vals(base_text(), "Config0", LED_REACT_TYPE9=3)),
]

mems = {}
for name, text in CASES:
    exp.save(text)
    exp.run(name)
    mems[name] = memory(parse(os.path.join(HERE, name + ".log")))
    print("done", name, flush=True)

base = mems["r_none"]
for name, _ in CASES[1:]:
    m = mems[name]
    ch = {hex(a): (base.get(a), m.get(a)) for a in sorted(set(base) | set(m)) if base.get(a) != m.get(a)}
    print("%-10s %d bytes %s" % (name, len(ch), ch), flush=True)
