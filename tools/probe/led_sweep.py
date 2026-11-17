#!/usr/bin/env python3
"""Sweep LED fields with explicit values and report which memory bytes change.

Usage: led_sweep.py SECTION.KEY=NEWVALUE [...]
Baseline is tools/probe/baseline.log; each case is one vendor-tool run.
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "led_map.json")
BASE = memory(parse(exp.BASE_LOG))
results = json.load(open(OUT)) if os.path.exists(OUT) else {}

def changed(mem):
    keys = sorted(set(BASE) | set(mem))
    return {"%#06x" % a: [BASE.get(a), mem.get(a)] for a in keys if BASE.get(a) != mem.get(a)}

for spec in sys.argv[1:]:
    name_val, newv = spec.split("=")
    sec, key = name_val.split(".")
    newv = int(newv)
    text = exp.set_vals(exp.load(), sec, **{key: newv})
    exp.save(text)
    run_name = ("led_%s_%s_%d" % (sec, key, newv)).lower()
    exp.run(run_name)
    m = memory(parse(os.path.join(HERE, run_name + ".log")))
    ch = changed(m)
    results[spec] = ch
    print("%-32s -> %2d byte(s) %s" % (spec, len(ch), ", ".join("%s:%s->%s" % (a, x, y) for a, (x, y) in list(ch.items())[:8])), flush=True)
    json.dump(results, open(OUT, "w"), indent=1)
print("saved", OUT)
