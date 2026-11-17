#!/usr/bin/env python3
"""Elige cada efecto EN LA UI y captura el byte que la herramienta escribe.

El ini no vale para esto: el desplegable muestra list[LED_TYPE], pero al pulsar
Apply la herramienta escribe otro número. Aquí se abre el desplegable y se elige
el elemento con un clic sostenido (el skin ignora el clic instantáneo de tap:
necesita mousedown, pausa y mouseup con el ratón ya encima).

    led_names_ui.py 0 1 2 ...      índices del desplegable (0 = Breathing)
"""
import json, os, subprocess, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp
from parse_log import parse, memory

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "led_names_ui.json")
X = 780              # centro de la lista desplegada
Y0 = 409             # primer elemento
STEP = 26            # separación entre elementos


def sh(*args):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "/work/tools/probe/ui.sh"] + list(args),
                          capture_output=True, text=True)


def raw_xdotool(script):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "-c",
                           "export DISPLAY=:99; " + script], capture_output=True, text=True)


def pick(index):
    exp.save(exp.load())            # siempre desde la misma base
    sh("start")
    sh("tap", "530", "200")         # pestaña LED
    sh("focus")
    sh("tap", "780", "379")         # abrir el desplegable
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
        print("indice %-2d -> 0x1C=0x%s -> modo %s" % (i, "??" if raw is None else "%02x" % raw, out[i]), flush=True)
        json.dump(out, open(OUT, "w"), indent=1)


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]])
