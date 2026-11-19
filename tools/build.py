#!/usr/bin/env python3
"""Bundle the configurator into a single HTML file that works on double click.

Two skins over the same UI (same app.js, same ids):

  classic  → dist/S700-configurator.html        (index.html + style.css)
  eva      → dist/S700-configurator-eva.html    (eva/index.html + eva/eva.css + eva/eva.js)

ES modules do not load from file://, so they are flattened into a classic script.
Usage:  tools/build.py [--ui classic|eva|ambas]   (default: both)
"""
import os, re, sys, subprocess, time, base64

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")

EXPORT_RE = re.compile(r"^export\s+(?:async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)", re.M)

UIS = {
    "classic": dict(
        html="index.html",
        css="style.css",
        extra=None,
        out="S700-configurator.html",
        check="bundle.check.js",
        css_tag='<link rel="stylesheet" href="./style.css">',
        app_tag='<script type="module" src="./app.js"></script>',
        extra_tag=None,
    ),
    "eva": dict(
        html="eva/index.html",
        css="eva/eva.css",
        extra="eva/eva.js",
        out="S700-configurator-eva.html",
        check="bundle.eva.check.js",
        css_tag='<link rel="stylesheet" href="./eva.css">',
        app_tag='<script type="module" src="../app.js"></script>',
        extra_tag='<script type="module" src="./eva.js"></script>',
    ),
}


def flatten(path):
    src = open(os.path.join(WEB, path), encoding="utf-8").read()
    src = re.sub(r'import\s+\*\s+as\s+(\w+)\s+from\s+"\./g6\.js";', r'const \1 = __g6;', src)
    src = re.sub(r'import\s+\*\s+as\s+(\w+)\s+from\s+"\./core\.js";', r'const \1 = __core;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./g6\.js";', r'const {\1} = __g6;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./core\.js";', r'const {\1} = __core;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./default_image\.js";', r'const {\1} = __image;', src)
    src = re.sub(r'import\s+\*\s+as\s+(\w+)\s*from\s+"\./storage\.js";', r'const \1 = __store;', src)
    names = EXPORT_RE.findall(src)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    if re.search(r"^\s*(import|export)\s", src, re.M):
        sys.exit("leftover import/export statements in " + path)
    return src, names


def stamp():
    try:
        rev = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5).stdout.strip() or "nogit"
    except Exception:
        rev = "nogit"
    return time.strftime("%Y-%m-%d %H:%M") + " · " + rev


def build(ui):
    cfg = UIS[ui]
    g6_src, g6_names = flatten("g6.js")
    core_src, core_names = flatten("core.js")
    image_src, image_names = flatten("default_image.js")
    store_src, store_names = flatten("storage.js")
    app_src, _ = flatten("app.js")
    extra_src = flatten(cfg["extra"])[0] if cfg["extra"] else ""

    bundle = f"""
(function () {{
"use strict";
const __g6 = (function () {{
{g6_src}
return {{ {", ".join(g6_names)} }};
}})();
const __core = (function () {{
{core_src}
return {{ {", ".join(core_names)} }};
}})();
const __image = (function () {{
{image_src}
return {{ {", ".join(image_names)} }};
}})();
const __store = (function () {{
{store_src}
return {{ {", ".join(store_names)} }};
}})();
{app_src}
}})();
"""
    css = open(os.path.join(WEB, cfg["css"]), encoding="utf-8").read()
    html = open(os.path.join(WEB, cfg["html"]), encoding="utf-8").read()

    img = os.path.join(WEB, "mouse.png")
    if not os.path.exists(img):
        sys.exit("missing web/mouse.png (the diagram image)")
    b64 = base64.b64encode(open(img, "rb").read()).decode()
    # the classic page sits next to web/mouse.png, the EVA page one level down
    for ref in ('src="./mouse.png"', 'src="../mouse.png"'):
        html = html.replace(ref, 'src="data:image/png;base64,%s"' % b64)

    html = html.replace("</head>", '<script>window.__S700_BUILD__ = "%s";</script>\n</head>' % stamp())

    for tag, repl in ((cfg["css_tag"], "<style>\n" + css + "\n</style>"),
                      (cfg["app_tag"], "<script>\n" + bundle + "\n</script>")):
        if tag not in html:
            sys.exit("cannot find %r in web/%s" % (tag, cfg["html"]))
        html = html.replace(tag, repl)
    if cfg["extra_tag"]:
        if cfg["extra_tag"] not in html:
            sys.exit("cannot find %r in web/%s" % (cfg["extra_tag"], cfg["html"]))
        html = html.replace(cfg["extra_tag"], "<script>\n" + extra_src + "\n</script>")

    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, cfg["out"])
    open(out, "w", encoding="utf-8").write(html)
    # the flattened bundle too, so it can be validated with node --check
    open(os.path.join(DIST, cfg["check"]), "w", encoding="utf-8").write(bundle + "\n" + extra_src + "\n")
    print("wrote", out, len(html), "bytes ·", ui)
    return len(g6_names), len(core_names)


def main():
    wanted = [a for a in sys.argv[1:] if not a.startswith("-")]
    if "--ui" in sys.argv:
        wanted = [sys.argv[sys.argv.index("--ui") + 1]]
    if not wanted:
        wanted = ["classic", "eva"]
    if wanted == ["ambas"] or wanted == ["all"]:
        wanted = ["classic", "eva"]
    for ui in wanted:
        if ui not in UIS:
            sys.exit("unknown skin: %s (classic|eva)" % ui)
        g6n, coren = build(ui)
    print("modules: g6=%d symbols, core=%d symbols" % (g6n, coren))


if __name__ == "__main__":
    main()
