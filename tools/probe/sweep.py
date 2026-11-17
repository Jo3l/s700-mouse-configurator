#!/usr/bin/env python3
"""Sweep one INI field at a time and record which device-memory bytes it changes."""
import json, os, re, sys, time
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
MAP = os.path.join(HERE, "map.json")
BASE = memory(parse(exp.BASE_LOG))

def ini_fields(text, sections):
    out = []
    for sec in sections:
        m = re.search(r"\[" + re.escape(sec) + r"\](.*?)(?=\n\[|\Z)", text, re.S)
        if not m:
            continue
        for line in m.group(1).splitlines():
            mm = re.match(r"\s*([A-Za-z0-9_]+)\s*=\s*(-?\d+)\s*$", line.strip())
            if mm:
                out.append((sec, mm.group(1), int(mm.group(2))))
    return out

def delta(v):
    if v >= 100:
        return v - 10
    return v + 1

def main(fields_sel):
    text = exp.load()
    fields = ini_fields(text, ["Config0", "ShareData"])
    results = {}
    if os.path.exists(MAP):
        results = json.load(open(MAP))
    todo = [f for f in fields if (f[0] + "." + f[1]) in fields_sel and (f[0] + "." + f[1]) not in results]
    for sec, key, val in todo:
        name = "%s_%s" % (sec, key)
        newv = delta(val)
        t = exp.set_vals(exp.load(), sec, **{key: newv})
        exp.save(t)
        try:
            exp.run(name)
            m = memory(parse(os.path.join(HERE, name + ".log")))
        except Exception as e:
            print("FAIL", name, e); continue
        changed = {("%#06x" % a): (BASE.get(a), m.get(a))
                   for a in sorted(set(BASE) | set(m)) if BASE.get(a) != m.get(a)}
        results[sec + "." + key] = {"old": val, "new": newv, "changed": changed}
        print("%-28s %4d->%-4d %2d byte(s) %s" % (sec + "." + key, val, newv, len(changed),
              ", ".join("%s:%s->%s" % (a, x, y) for a, (x, y) in list(changed.items())[:6])))
        json.dump(results, open(MAP, "w"), indent=1)

if __name__ == "__main__":
    main(set(sys.argv[1:]))
