# project shortcuts
PY ?= python3

.PHONY: build build-eva test serve docker native native-linux appimage native-run clean

build:           ## bundles both skins (dist/S700-configurator.html and -eva.html)
	$(PY) tools/build.py

build-eva:       ## EVA skin only (dist/S700-configurator-eva.html)
	$(PY) tools/build.py --ui eva

test:            ## protocol, codec, core, transport and UI tests
	$(PY) tools/test_g6proto.py
	node tools/test_codec.mjs
	node tools/test_core.mjs
	node tools/test_transport.mjs
	node tools/test_ui.mjs
	node tools/test_ui_eva.mjs
	node tools/test_storage.mjs
	node tools/test_bridge.mjs

serve:           ## web configurator at http://localhost:8099/web/
	$(PY) -m http.server 8099 --bind 127.0.0.1

native:          ## native configurator binary (native/, see docs/NATIVE.md)
	cd native && cargo build --release

# same as CI: Ubuntu 22.04 (glibc 2.35) + WebKitGTK 4.1, installing
# nothing on the host.
native-linux:    ## builds the native binary in a container
	docker run --rm -v "$(CURDIR):/w" -w /w/native ubuntu:22.04 bash -c '\
		export DEBIAN_FRONTEND=noninteractive; \
		apt-get update -qq; \
		apt-get install -y -qq curl ca-certificates build-essential pkg-config \
		libwebkit2gtk-4.1-dev libgtk-3-dev libsoup-3.0-dev libx11-dev >/dev/null; \
		curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null; \
		. "$$HOME/.cargo/env"; \
		cargo build --release'
	docker run --rm -v "$(CURDIR):/w" ubuntu:22.04 chown -R $(shell id -u):$(shell id -g) /w/native/target

appimage:        ## self-contained AppImage for Linux x86_64 (bundles WebKitGTK)
	./native/build-appimage.sh

native-run: native           ## opens the UI served by the native binary
	./native/target/release/s700-host

docker:          ## Wine image with the capture harness
	docker build -f tools/Dockerfile.wine -t g6re:local .

clean:
	rm -rf tools/__pycache__ tools/probe/__pycache__ web/__pycache__ tools/probe/*.log dist/bundle.check.js
	cp tools/probe/orig.ini tools/probe/in.ini
