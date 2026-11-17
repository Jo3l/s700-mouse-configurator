#!/usr/bin/env python3
"""Empaqueta el configurador en un único HTML que funciona abriéndolo con doble clic.

Los módulos ES no cargan desde file://, así que se aplanan a un script clásico.
Salida: dist/S700-configurador.html
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
DIST = os.path.join(ROOT, "dist")

EXPORT_RE = re.compile(r"^export\s+(?:async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)", re.M)


def flatten(path, deps):
    src = open(os.path.join(WEB, path), encoding="utf-8").read()
    # imports -> destructuring de los módulos ya aplanados
    src = re.sub(r'import\s+\*\s+as\s+(\w+)\s+from\s+"\./g6\.js";', r'const \1 = __g6;', src)
    src = re.sub(r'import\s+\*\s+as\s+(\w+)\s+from\s+"\./core\.js";', r'const \1 = __core;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./g6\.js";', r'const {\1} = __g6;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./core\.js";', r'const {\1} = __core;', src)
    src = re.sub(r'import\s*\{([^}]*)\}\s*from\s*"\./default_image\.js";', r'const {\1} = __image;', src)
    src = re.sub(r'import\s*\*\s*as\s+(\w+)\s*from\s*"\./storage\.js";', r'const \1 = __store;', src)
    names = EXPORT_RE.findall(src)
    src = re.sub(r"^export\s+", "", src, flags=re.M)
    if re.search(r"^\s*(import|export)\s", src, re.M):
        sys.exit("quedan sentencias import/export en " + path)
    return src, names


def main():
    g6_src, g6_names = flatten("g6.js", [])
    core_src, core_names = flatten("core.js", ["g6"])
    image_src, image_names = flatten("default_image.js", [])
    store_src, store_names = flatten("storage.js", [])
    app_src, _ = flatten("app.js", ["g6", "core", "image", "storage"])
    css = open(os.path.join(WEB, "style.css"), encoding="utf-8").read()
    html = open(os.path.join(WEB, "index.html"), encoding="utf-8").read()

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
    # la imagen del ratón viaja dentro del HTML para que el fichero sea único
    img = os.path.join(WEB, "mouse.png")
    if not os.path.exists(img):
        sys.exit("falta web/mouse.png (la imagen del diagrama)")
    import base64
    b64 = base64.b64encode(open(img, "rb").read()).decode()
    html = html.replace('src="./mouse.png"', 'src="data:image/png;base64,%s"' % b64)

    # sello de compilación: la página lo muestra en Debug, así se sabe de un
    # vistazo si el navegador está sirviendo una copia vieja de caché.
    import subprocess, time
    try:
        rev = subprocess.run(["git", "-C", ROOT, "rev-parse", "--short", "HEAD"],
                             capture_output=True, text=True, timeout=5).stdout.strip() or "nogit"
    except Exception:
        rev = "nogit"
    stamp = time.strftime("%Y-%m-%d %H:%M") + " · " + rev
    html = html.replace("</head>", '<script>window.__S700_BUILD__ = "%s";</script>\n</head>' % stamp)

    html = html.replace('<link rel="stylesheet" href="./style.css">', "<style>\n" + css + "\n</style>")
    html = html.replace('<script type="module" src="./app.js"></script>',
                        "<script>\n" + bundle + "\n</script>")
    os.makedirs(DIST, exist_ok=True)
    out = os.path.join(DIST, "S700-configurador.html")
    open(out, "w", encoding="utf-8").write(html)
    # el script aplanado también, para poder validarlo con node --check
    open(os.path.join(DIST, "bundle.check.js"), "w", encoding="utf-8").write(bundle)
    print("escrito", out, len(html), "bytes")
    print("módulos: g6=%d simbolos, core=%d simbolos" % (len(g6_names), len(core_names)))


if __name__ == "__main__":
    main()
