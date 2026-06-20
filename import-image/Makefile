# Netlify sets NETLIFY=true; use tools directly there since Docker isn't available.
ifdef NETLIFY
run = $(1)
playwright = node_modules/.bin/playwright
else
run = docker compose run --rm $(2) main $(1)
playwright = docker compose run --rm playwright node_modules/.bin/playwright
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
	$(bun) test src lib

build: node_modules
	$(bun) run scripts/build.ts

# Download the oemer ONNX weights into public/models/ (gitignored, ~109 MB).
# Needed once before `make build`/`make dev` can serve a working app locally.
models: node_modules
	$(bun) run scripts/download-models.ts

# Optimize the downloaded weights with onnxsim (fixed input shape) — the only
# transform turning the oemer originals into the served v2 weights. Folds away
# the dynamic-shape ops that force per-tile GPU<->CPU syncs on the WebGPU path,
# asserting the result stays numerically identical (the served weights predict
# bit-for-bit the same as the public release). Run once, out of band, after
# `make models` and before `make build`/`make upload-models`; rewrites
# public/models/ in place. See docs/model-weights.md.
optimize-models: models
	docker compose run --rm python sh -c '\
		pip install --quiet onnx==1.16.2 onnxsim==0.4.36 onnxruntime==1.18.1 numpy==1.26.4 \
		&& python scripts/optimize-models.py'

# Headless low-vs-high-resolution validation of the segmentation pixel budget
# (run via `make compare-resolutions`). Runs the real v2 pipeline on CPU
# (onnxruntime-node) over samples/ at a high-res reference and lower budgets and
# reports whether the detected staff structure + masks still agree — the check
# behind lowering `lib/input/preprocess.ts`. Out of band; needs `make models`
# and pages in samples/ (gitignored). Pass flags via ARGS, e.g.
# `make compare-resolutions ARGS="--candidates 1500000,1000000"`.
compare-resolutions: node_modules models
	$(bun) run scripts/compare-resolutions.ts $(ARGS)

# Upload the weights to Netlify Blobs once, out of band (deploy-time upload was
# too slow). Downloads them in the bun container, then runs `netlify blobs:set`
# per file in a Node container. Requires NETLIFY_AUTH_TOKEN and NETLIFY_SITE_ID
# in your environment.
upload-models: node_modules
	$(bun) run scripts/upload-models.ts
	docker compose run --rm netlify-cli node scripts/blob-upload.mjs

# Pre-create the output directory as the host user so Docker (running as root)
# writes into it rather than creating a root-owned directory.
tests/integration/results:
	mkdir -p tests/integration/results

# Browser-level acceptance check (cross-origin isolation, inference provider).
# Not part of pr-ready: it needs the Playwright browser image and is the
# automated form of the manual Phase 0 acceptance check.
integration-test: build node_modules tests/integration/results
	$(playwright) test

up:
	docker compose up -d

down:
	docker compose down

dev: build
	$(bun) build src/main.tsx --outdir dist --watch

pr-ready: format lint typecheck build unit-test
