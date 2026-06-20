# Root tooling for the editor (editor/), the MusicXML editor that will become
# this repo's primary app. The original pdf-to-musicxml OMR pipeline lives,
# self-contained, under import-image/ with its own Makefile — run its targets
# from inside that directory.
#
# Netlify sets NETLIFY=true; use tools directly there since Docker isn't
# available.
ifdef NETLIFY
run = $(1)
else
run = docker compose run --rm main $(1)
endif

bun = $(call run,bun)
biome = $(call run,./node_modules/.bin/biome)
tsc = $(call run,./node_modules/.bin/tsc)

# Pre-create node_modules before Docker runs so the directory is owned by the
# host user (Docker would otherwise create it as root).
node_modules: package.json
	mkdir -p node_modules
	$(bun) install

format: node_modules
	$(biome) format --write .

lint: node_modules
	$(biome) lint .

typecheck: node_modules
	$(tsc) --noEmit

unit-test: node_modules
	$(bun) test editor

# The WYSIWYG MusicXML editor (editor/) is a self-contained Bun workspace
# member. This is also the Netlify build target once the editor deploy is wired
# up (today Netlify still deploys import-image — see netlify.toml).
build-editor: node_modules
	mkdir -p editor/dist
	$(bun) build editor/src/main.tsx --outdir editor/dist --minify

build: build-editor

dev: build-editor
	$(bun) build editor/src/main.tsx --outdir editor/dist --watch

up:
	docker compose up -d

down:
	docker compose down

pr-ready: format lint typecheck build unit-test
