#!/usr/bin/env python3
"""Drive the vendor UI through a list of cases and save, per case:
image (HID log), shot and the config.ini the tool leaves behind.

    led_cases.py cases.json

cases.json = {
  "effect": 3,                       # dropdown index to pick first
  "cases": [ {"name": "bright_min", "actions": [["click",700,528]]}, ... ]
}

Every case ends with an Apply. The log is later split on the END markers (cmd 0x10).
"""
import json, os, subprocess, sys, time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import exp

HERE = os.path.dirname(os.path.abspath(__file__))
X, Y0, STEP = 780, 409, 26


def sh(*args):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "/work/tools/probe/ui.sh"] + list(args),
                          capture_output=True, text=True)


def xdo(script):
    return subprocess.run(["docker", "exec", "g6re-run", "bash", "-c",
                           "export DISPLAY=:99; " + script], capture_output=True, text=True)


def held_click(x, y):
    xdo("xdotool mousemove %d %d; sleep 0.5; xdotool mousedown 1; sleep 0.3; xdotool mouseup 1" % (x, y))


def cp(src, dst):
    subprocess.run(["docker", "cp", "g6re-run:" + src, dst], capture_output=True, text=True)


def do(actions):
    for a in actions:
        kind = a[0]
        if kind == "click":
            sh("tap", str(a[1]), str(a[2]))
        elif kind == "held":
            held_click(a[1], a[2])
        elif kind == "drag":
            xdo("xdotool mousemove %d %d; sleep 0.3; xdotool mousedown 1; sleep 0.3; "
                "xdotool mousemove %d %d; sleep 0.5; xdotool mouseup 1" % (a[1], a[2], a[3], a[4]))
        elif kind == "sleep":
            time.sleep(a[1])
        else:
            raise SystemExit("unknown action " + kind)
        time.sleep(0.6)


def pick_effect(i):
    sh("tap", "780", "379")
    time.sleep(1)
    held_click(X, Y0 + STEP * i)
    time.sleep(1.2)


def main(spec_path):
    spec = json.load(open(spec_path))
    exp.save(exp.load())
    sh("start")
    sh("tap", "530", "200")
    sh("focus")
    if spec.get("effect") is not None:
        pick_effect(spec["effect"])
    for case in spec["cases"]:
        name = case["name"]
        do(case.get("actions", []))
        if case.get("shot", True):
            sh("shot", "case_" + name)
        sh("tap", "853", "850")
        time.sleep(2.2)
        cp("/app/skins/config/config.ini", os.path.join(HERE, "ini_%s.ini" % name))
        print("case", name, flush=True)
    sh("save", "cases")
    sh("stop")


if __name__ == "__main__":
    main(sys.argv[1])
