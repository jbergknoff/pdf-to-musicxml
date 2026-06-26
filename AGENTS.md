# Agent notes (monorepo root)

This repository is **`musicxml-editor`**: a WYSIWYG MusicXML editor whose
"import from an image/PDF" feature is the old `pdf-to-musicxml` OMR pipeline. The
two are now **integrated** — the editor's Import control routes PDFs and raster
images through the OMR pipeline (which lives under `lib/import-image/`) and loads
the recovered MusicXML into the editor; `.musicxml`/`.xml` files are still parsed
directly.

## Layout

```
editor/             The WYSIWYG MusicXML editor (Preact). The primary app and the
                    deploy target. Its Import feature calls the OMR pipeline via
                    lib/import-image's API. See editor/PLAN.md.

lib/import-image/   The OMR pipeline (the original pdf-to-musicxml app), moved
                    here and folded into the root toolchain — its standalone
                    Makefile / docker-compose / netlify.toml / package.json were
                    removed and merged into the root. Its own lib/ (runtime-
                    agnostic core), src/ (worker, decode, ORT backend, model
                    registry), netlify/functions, scripts, and tests are intact.
                    lib/import-image/index.ts is the public API. See
                    lib/import-image/AGENTS.md and PLAN.md for the pipeline.
```

### The import API — `lib/import-image/index.ts`

`createImageImporter()` → an `ImageImporter` whose `importFile(file, onProgress)`
decodes a PDF/image on the main thread and runs segmentation → staff detection →
TrOMR transcription in the OMR worker, returning a MusicXML string. Multi-page
PDFs are recognized a page at a time and stitched into one document (measure
numbers run continuously across pages); progress updates carry `page`/`pageCount`
for those. `imageToMusicXml(file)` is the one-shot convenience. The editor wraps
this in `editor/src/use-image-import.ts` and calls it from `Editor.tsx`'s Import
handler.

Inference runs in `lib/import-image/src/worker/omr.worker.ts`, bundled by the
build into `editor/dist/omr.worker.js` and loaded via `new Worker("/omr.worker.js")`.
ORT WASM, the pdf.js worker, and the model weights are fetched at run time, so the
page must be cross-origin isolated (COOP/COEP).

## Root tooling

The repo root is a Bun workspace whose member is `editor/`; the OMR runtime deps
(onnxruntime-web, pdfjs-dist, opensheetmusicdisplay, …) are merged into the root
`package.json`. Local requirements are `make` and `docker` (Bun/Biome/tsc/
Playwright run in containers via docker-compose).

```sh
make build         # scripts/build-editor.ts -> editor/dist (editor + OMR worker + assets)
make dev           # build, then rebuild on change
make up / make down # serve editor/dist on :3456 with COOP/COEP (scripts/serve.ts)
make format        # biome format --write
make lint          # biome lint
make typecheck     # tsc --noEmit
make unit-test     # bun test editor + lib/import-image lib/src
make integration-test # Playwright (lib/import-image/playwright.config.ts)
make editor-integration-test # Playwright editor editing-flow tests
                   # (playwright.editor.config.ts): select/add/delete/undo and
                   # the view-only guard for multi-staff scores, driving the
                   # served editor/dist in the pinned browser image.
make omr-integration-test # end-to-end OMR: real pipeline (Node/CPU) over
                   # musicxml.com fixture images, diffing the recovered MusicXML
                   # against each fixture's source score (only codified
                   # affordances allowed) + an OSMD screenshot. Slow but
                   # deterministic; downloads the v2 weights once into
                   # public/models/. Regenerate screenshots with
                   # ARGS=--update-snapshots.
make pr-ready      # format, lint, typecheck, build, unit-test
```

The OMR integration tests (`lib/import-image/tests/integration/import-image.spec.ts`,
config `playwright.omr.config.ts`) run the recognition pipeline headlessly in
Node (onnxruntime-node, CPU — `tests/integration/helpers/omr-pipeline.ts` mirrors
`omr.worker.ts`) so the recovered MusicXML is deterministic, then **diff it against
the fixture's source score** (`helpers/musicxml-diff.ts`) and render it with OSMD
in Chromium for a screenshot. The recovered MusicXML is **not** committed — each
fixture instead lists, in the spec's `EXPECTED_DIFFERENCES`, the specific
currently-expected ways its recovery differs from the real score (the "affordances").
The diff is a two-way ratchet: an uncodified difference fails (regression), and an
affordance that no longer matches any actual difference also fails (improve the OMR,
then delete the affordance). Fixtures (images + `*.source.musicxml`) and the
committed screenshot baselines live under `tests/integration/fixtures/` and
`tests/integration/__snapshots__/` (screenshots only). CI runs them in the
`omr-integration` job (separate from the editor job; caches the weights).

**Running the OMR integration tests (weights).** The suite needs the ~109 MB
weights in `lib/import-image/public/models/`. `ensureModels` fetches them on first
run from the served (Netlify) host the app uses, falling back to the upstream
GitHub releases (`scripts/model-source.ts`) if that host is unreachable. The
fixtures use the model-free *classical* staff path and the TrOMR weights are
served as-is, so the upstream weights recover byte-identical MusicXML — either
source works. **On a network-restricted machine (e.g. Claude Code on the web,
whose egress proxy CA is mounted only into the `main` Docker service, not
`playwright`): run `make models` first.** That downloads from the upstream
releases inside the `main` container (which has the proxy CA) into the shared
`public/models/` volume; `make omr-integration-test` (the `playwright` container)
then finds them and skips the network fetch. The screenshots render in the pinned
Playwright image, so baselines regenerated locally (`ARGS=--update-snapshots`)
match CI.

Out-of-band OMR model-weight targets (weights are ~109 MB, gitignored, not
committed) run inside `lib/import-image/` so their relative paths resolve:
`make models` (download), `make optimize-models` (onnxsim to v2),
`make upload-models` (to Netlify Blobs), `make compare-resolutions`.

`editor/src/test-setup.ts` (linkedom DOM globals) is preloaded for the editor's
tests via root `bunfig.toml`.

## Deployment

Netlify deploys the **editor**: `netlify.toml` builds with `make build-editor`,
publishes `editor/dist`, sets the COOP/COEP headers the OMR WASM backend needs,
and points `[functions]` at `lib/import-image/netlify/functions` so the models
function streams the weights same-origin at `/models/<file>` (required under
COEP). The weights themselves are uploaded once, out of band, to Netlify Blobs
(`make upload-models`) — not part of the static deploy. Locally `scripts/serve.ts`
serves the same `/models/<file>` URLs from `lib/import-image/public/models/`.

## Conventions

Carried from the sibling piano-practice repo: full words in names, braces around
every conditional/loop body, `PascalCase` components and `kebab-case` everything
else, `lib/` runtime-agnostic. Run `make pr-ready` before committing.
