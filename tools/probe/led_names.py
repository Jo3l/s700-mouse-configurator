#!/usr/bin/env python3
"""Empareja cada efecto del desplegable del fabricante con el byte que escribe.

Para cada LED_TYPE del ini: arranca la herramienta, abre la pestaña LED, hace una
foto del desplegable, pulsa Apply para que escriba, y guarda el byte 0x1C del log.
Con eso queda nombre -> byte sin adivinar el orden de la lista.

Salida: tools/probe/led_names.json y una tira PNG con las fotos para leerlas de un
vistazo (tools/probe/led_names.png).
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "led_names.json")
CROP = (700, 362, 870, 392)   # el valor del desplegable de modo


def sh(*args):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "/work/tools/probe/ui.sh"] + list(args),
                          capture_output=True, text=True)


def main(modes):
    out = {}
    for k in modes:
        text = exp.set_vals(exp.load(), "ShareData", LED_TYPE=k)
        exp.save(text)
        sh("start")
        sh("tap", "530", "200")          # pestaña LED
        sh("shot", "mode_%d" % k)
        sh("tap", "853", "850")          # Apply
        subprocess.run(["sleep", "2"])
        sh("save", "mode_%d" % k)
        sh("stop")
        log = os.path.join(HERE, "mode_%d.log" % k)
        mem = memory(parse(log)) if os.path.exists(log) else {}
        raw = mem.get(0x1C)
        out[k] = None if raw is None else raw >> 4
        print("ini LED_TYPE=%-3d -> byte 0x%s -> modo %s" % (k, "??" if raw is None else "%02x" % raw, out[k]), flush=True)
    json.dump(out, open(OUT, "w"), indent=1)
    print("guardado", OUT)


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or list(range(14)))
