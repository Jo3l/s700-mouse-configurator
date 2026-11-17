#!/usr/bin/env python3
"""Differential probing helpers: edit the vendor config.ini, run the tool under
Wine, and diff the bytes it writes to the mouse."""
import os, re, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "in.ini")
ORIG = os.path.join(HERE, "orig.ini")
BASE_LOG = os.path.join(HERE, "baseline.log")


def load(path=ORIG):
    return open(path, "rb").read().decode("gb18030")


def save(text, path=SRC):
    open(path, "wb").write(text.encode("gb18030"))


def set_vals(text, section, **kv):
    """Replace KEY=value inside [section] only."""
    m = re.search(r"\[" + re.escape(section) + r"\](.*?)(?=\n\[|\Z)", text, re.S)
    if not m:
        raise SystemExit("section not found: " + section)
    body = m.group(1)
    new = body
    for k, v in kv.items():
        pat = re.compile(r"^(\s*" + re.escape(k) + r"\s*=)[^\r\n]*", re.M)
        if not pat.search(new):
            raise SystemExit("key not found: %s in [%s]" % (k, section))
        new = pat.sub(lambda mm: mm.group(1) + str(v), new, count=1)
    return text[: m.start(1)] + new + text[m.end(1):]


def run(name):
    r = subprocess.run(["docker", "exec", "g6re-run", "bash",
                        "/work/tools/probe/probe.sh", name],
                       capture_output=True, text=True)
    print(r.stdout.strip(), r.stderr.strip())
    return os.path.join(HERE, name + ".log")


def diff(name, base_log=BASE_LOG):
    b = memory(parse(base_log))
    m = memory(parse(os.path.join(HERE, name + ".log")))
    keys = sorted(set(b) | set(m))
    ch = [(a, b.get(a), m.get(a)) for a in keys if b.get(a) != m.get(a)]
    print(f"{len(ch)} changed bytes")
    for a, x, y in ch:
        print(f"  {a:#06x}: {x if x is None else format(x,'02x')} -> {y if y is None else format(y,'02x')}")
    return ch
