# Atajos del proyecto
PY ?= python3

.PHONY: build test serve debug docker native native-run clean

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
	cd native && cargo build --release --offline

native-run: native           ## abre la UI servida por el binario nativo
	./native/target/release/s700-host

docker:          ## imagen de Wine con el arnés de captura
	docker build -f tools/Dockerfile.wine -t g6re:local .

clean:
	rm -rf tools/__pycache__ tools/probe/__pycache__ web/__pycache__ tools/probe/*.log dist/bundle.check.js
	cp tools/probe/orig.ini tools/probe/in.ini
