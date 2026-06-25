# Root tooling for the editor (editor/), this repo's primary app. The editor's
# "import from image/PDF" feature runs the OMR pipeline that now lives under
# lib/import-image/ (moved here from its own top-level app and folded into this
# root toolchain).
#
# Netlify sets NETLIFY=true; use the tools directly there since Docker isn't
# available.
ifdef NETLIFY
run = $(1)
playwright = node_modules/.bin/playwright
playwright_omr = node_modules/.bin/playwright
else
run = docker compose run --rm main $(1)
playwright = docker compose run --rm playwright node_modules/.bin/playwright
# The OMR integration tests render with OSMD via page.setContent and run
# inference in Node, so they need no static server — skip the compose deps
# (--no-deps) that the page-shell integration test relies on.
playwright_omr = docker compose run --rm --no-deps playwright node_modules/.bin/playwright
endif

bun = $(call run,bun)
biome = $(call run,./node_modules/.bin/biome)
tsc = $(call run,./node_modules/.bin/tsc)

# Anything under lib/import-image whose scripts use paths relative to that
# directory (model download/optimize, sample comparison) runs with it as the cwd.
in_import_image = $(call run,sh -c 'cd lib/import-image && $(1)')

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

# Editor tests plus the OMR pipeline's lib/src tests. Scoped to those trees so
# `bun test` does not pick up lib/import-image/tests/ (Playwright integration).
unit-test: node_modules
	$(bun) test editor lib/import-image/lib lib/import-image/src

# Build the editor SPA (+ the bundled OMR worker and its ORT/pdf.js assets) into
# editor/dist. This is the Netlify build target (see netlify.toml).
build-editor: node_modules
	$(bun) run scripts/build-editor.ts

build: build-editor

dev: build-editor
	$(bun) build editor/src/main.tsx --outdir editor/dist --watch

up:
	docker compose up -d

down:
	docker compose down

# --- OMR model weights (out of band; see lib/import-image/AGENTS.md) ----------
# These run inside lib/import-image so their relative paths (public/models/,
# samples/) resolve there. The weights (~109 MB) are gitignored.

# Download the oemer ONNX weights into lib/import-image/public/models/.
models: node_modules
	$(call in_import_image,bun run scripts/download-models.ts)

# Optimize the downloaded weights with onnxsim (fixed input shape) into the
# served v2 form. Run once, after `make models`. See docs/model-weights.md.
optimize-models: models
	docker compose run --rm python sh -c 'cd lib/import-image \
		&& pip install --quiet onnx==1.16.2 onnxsim==0.4.36 onnxruntime==1.18.1 numpy==1.26.4 \
		&& python scripts/optimize-models.py'

# Headless low-vs-high-resolution validation of the segmentation pixel budget.
# Out of band; needs `make models` and pages in lib/import-image/samples/.
compare-resolutions: node_modules models
	$(call in_import_image,bun run scripts/compare-resolutions.ts $(ARGS))

# Upload the weights to Netlify Blobs once, out of band. Requires
# NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID in your environment.
upload-models: node_modules
	$(call in_import_image,bun run scripts/upload-models.ts)
	docker compose run --rm netlify-cli sh -c 'cd lib/import-image && node scripts/blob-upload.mjs'

# Browser-level acceptance check (cross-origin isolation, inference provider).
# Not part of pr-ready: it needs the Playwright browser image.
integration-test: build node_modules
	$(playwright) test --config lib/import-image/playwright.config.ts

# End-to-end OMR integration tests: run the real recognition pipeline in Node
# (onnxruntime-node, CPU) over the musicxml.com fixture images and assert both
# the recovered MusicXML and an OSMD screenshot of it. Slow (~minutes) but
# deterministic. Downloads the v2 model weights once into public/models/ (cached
# on disk). Not in pr-ready: needs the Playwright browser image and network for
# the one-time weight download. Regenerate baselines with ARGS=--update-snapshots.
omr-integration-test: node_modules
	$(playwright_omr) test --config lib/import-image/playwright.omr.config.ts $(ARGS)

# Compare HOMR (https://github.com/liebharc/homr, AGPL-3.0) against our
# integration test fixtures. Step 1: install HOMR and run it on each fixture
# image (outputs to lib/import-image/tmp/homr-output/). Step 2: diff the
# recovered MusicXML against source scores and print a side-by-side report.
# HOMR downloads its own model weights (~100 MB) on first use, cached in
# .homr-cache/ (XDG_CACHE_HOME). Idempotent: already-recovered fixtures are
# skipped (delete tmp/homr-output/<name>.musicxml to re-run one).
homr-comparison: node_modules
	docker compose run --rm homr sh -c \
		'pip install --quiet homr && cd lib/import-image && python scripts/run-homr.py'
	$(call in_import_image,bun run scripts/compare-homr.ts)

pr-ready: format lint typecheck build unit-test
