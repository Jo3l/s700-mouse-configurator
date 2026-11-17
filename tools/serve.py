#!/usr/bin/env python3
"""Sirve una carpeta por HTTP o HTTPS (WebHID exige contexto seguro).

    python3 tools/serve.py 8099            # http://0.0.0.0:8099
    python3 tools/serve.py 8443 --tls       # https con certificado autofirmado

El certificado se genera la primera vez en certs/ e incluye la IP local en el SAN.
"""
import argparse, http.server, os, socket, ssl, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERTS = os.path.join(ROOT, "certs")


def local_ip():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))
        return s.getsockname()[0]
    finally:
        s.close()


def ensure_cert(ip):
    os.makedirs(CERTS, exist_ok=True)
    key = os.path.join(CERTS, "dev-key.pem")
    crt = os.path.join(CERTS, "dev.pem")
    if os.path.exists(key) and os.path.exists(crt):
        return crt, key
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", key, "-out", crt, "-days", "825",
        "-subj", "/CN=s700.local",
        "-addext", f"subjectAltName=DNS:localhost,IP:127.0.0.1,IP:{ip}",
    ], check=True, capture_output=True)
    return crt, key


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port", type=int)
    ap.add_argument("--tls", action="store_true")
    ap.add_argument("--dir", default=ROOT)
    args = ap.parse_args()

    handler = lambda *a, **k: http.server.SimpleHTTPRequestHandler(*a, directory=args.dir, **k)
    httpd = http.server.ThreadingHTTPServer(("0.0.0.0", args.port), handler)
    scheme = "http"
    if args.tls:
        crt, key = ensure_cert(local_ip())
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(crt, key)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        scheme = "https"
    print(f"http://{local_ip()}:{args.port}/  ({scheme}, sirviendo {args.dir})", flush=True)
    httpd.serve_forever()


if __name__ == "__main__":
    main()
