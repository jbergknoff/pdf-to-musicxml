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

# Stage the weights into .netlify/blobs/deploy/ so Netlify seeds them into the
# deploy's blob store (served by netlify/functions/models.mts). Run during the
# Netlify build, before `build`.
stage-models: node_modules
	$(bun) run scripts/stage-models.ts

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
