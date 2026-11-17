#!/usr/bin/env python3
"""Captura, por cada efecto del desplegable del fabricante, el panel de opciones
que muestra la UI y la imagen completa que escribe en el raton.

Una sola sesion: se elige el efecto con clic sostenido, foto, Apply, foto y se
copia el config.ini que deje la herramienta. El log de HID se parte luego por
los marcadores END (cmd 0x10) para tener una imagen por Apply.
"""
import os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp

HERE = os.path.dirname(os.path.abspath(__file__))
X = 780
Y0 = 409
STEP = 26


def sh(*args):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "/work/tools/probe/ui.sh"] + list(args),
                          capture_output=True, text=True)


def xdo(script):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "-c",
                           "export DISPLAY=:99; " + script], capture_output=True, text=True)


def held_click(x, y):
    xdo("xdotool mousemove %d %d; sleep 0.5; xdotool mousedown 1; sleep 0.3; xdotool mouseup 1" % (x, y))


def cp_ini(tag):
    subprocess.run(["docker", "cp", "g6re-run:/app/skins/config/config.ini",
                    os.path.join(HERE, "ini_%s.ini" % tag)], capture_output=True, text=True)


def main(idxs):
    exp.save(exp.load())
    sh("start")
    sh("tap", "530", "200")
    sh("focus")
    for i in idxs:
        sh("tap", "780", "379")
        time.sleep(1)
        held_click(X, Y0 + STEP * i)
        time.sleep(1.2)
        sh("shot", "eff_%02d" % i)
        sh("tap", "853", "850")
        time.sleep(2.5)
        sh("shot", "post_%02d" % i)
        cp_ini("%02d" % i)
        print("efecto %02d: foto + apply + ini" % i, flush=True)
    sh("save", "effects")
    sh("stop")


if __name__ == "__main__":
    main([int(a) for a in sys.argv[1:]] or list(range(14)))
