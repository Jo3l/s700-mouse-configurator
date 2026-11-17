# Atajos del proyecto
PY ?= python3

.PHONY: build test serve debug docker native native-linux native-run clean

build:           ## empaqueta dist/S700-configurador.html (un solo fichero)
	$(PY) tools/build.py

test:            ## pruebas de protocolo, códec, core, transporte y UI
	$(PY) tools/test_g6proto.py
	node tools/test_codec.mjs
	node tools/test_core.mjs
	node tools/test_transport.mjs
	node tools/test_ui.mjs
	node tools/test_storage.mjs
	node tools/test_bridge.mjs

serve:           ## configurador web en http://localhost:8099/web/
	$(PY) -m http.server 8099 --bind 127.0.0.1

debug:           ## servidor de depuración con API en vivo (http 8099, https 8443)
	$(PY) tools/debugd.py 8099 --also-tls 8443

native:          ## binario nativo del configurador (native/, ver docs/NATIVE.md)
	cd native && cargo build --release

# Igual que el CI: Ubuntu 22.04 (glibc 2.35) + WebKitGTK 4.1, sin instalar
# nada en el anfitrión.
native-linux:    ## compila el binario nativo en un contenedor
	docker run --rm -v "$(CURDIR):/w" -w /w/native ubuntu:22.04 bash -c '\
		export DEBIAN_FRONTEND=noninteractive; \
		apt-get update -qq; \
		apt-get install -y -qq curl ca-certificates build-essential pkg-config \
		libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libx11-dev >/dev/null; \
		curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null; \
		. "$$HOME/.cargo/env"; \
		cargo build --release'
	docker run --rm -v "$(CURDIR):/w" ubuntu:22.04 chown -R $(shell id -u):$(shell id -g) /w/native/target

native-run: native           ## abre la UI servida por el binario nativo
	./native/target/release/s700-host

docker:          ## imagen de Wine con el arnés de captura
	docker build -f tools/Dockerfile.wine -t g6re:local .

clean:
	rm -rf tools/__pycache__ tools/probe/__pycache__ web/__pycache__ tools/probe/*.log dist/bundle.check.js
	cp tools/probe/orig.ini tools/probe/in.ini
