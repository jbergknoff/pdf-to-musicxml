# pdf-to-musicxml

Convert a PDF or image of printed sheet music into [MusicXML](https://www.musicxml.com/),
**entirely in the browser**. Drop in a score, get back a downloadable `.musicxml`
file — no image ever leaves your device.

This is client-side [Optical Music Recognition (OMR)](https://en.wikipedia.org/wiki/Optical_music_recognition):
all inference runs locally via [ONNX Runtime Web](https://onnxruntime.ai/docs/tutorials/web/)
(WebGPU, with a WASM fallback), so the app is hostable as static files with no
backend.

## Intent

- **In:** a PDF or image (PNG/JPG) of printed Western music notation.
  **Out:** a downloadable `.musicxml` file.
- **100% client-side.** No network round-trip for the image; works offline once
  assets are cached.
- **Piano grand staff** is the target output, reached in phases (monophonic
  single staff first).

The recognition pipeline follows the proven segment → locate staves →
transcribe → assemble design: a UNet segmentation model finds the staves, a
transformer reads each cropped staff into a token sequence, and an algorithmic
decoder reassembles notes, measures, and voices into MusicXML. See
[`PLAN.md`](./PLAN.md) for the full design, model/licensing strategy, pipeline
details, and phased build order.

## Status

**Phase 0 (toolchain scaffold) — complete:**

- `bun build` bundles ONNX Runtime Web's threaded WASM backend (no Vite needed).
- The page is cross-origin isolated (COOP/COEP) so ORT Web can use
  `SharedArrayBuffer`, in both dev (`scripts/serve.ts`) and production
  (`netlify.toml`).
- A runtime-agnostic inference interface (`lib/runtime/inference-backend.ts`)
  keeps `lib/` free of any concrete ORT import; the browser implementation lives
  in `src/runtime/web-backend.ts`.

**Phase 1 (segmentation) — complete:** drop a PDF or image and the two
[oemer](https://github.com/BreezeWhite/oemer) UNets run in the browser, with the
detected stafflines and symbols overlaid on the page.

- Input decoding (raster via `createImageBitmap`, PDF via pdf.js) and
  preprocessing into oemer's training pixel budget.
- Tiled inference: a sliding window over the page, batched through ORT Web, with
  the per-tile softmax outputs averaged back together (`lib/segmentation/`).
- The first model (`unet_big`) separates stafflines from symbols; the second
  (`seg_net`) splits symbols into noteheads, stems/rests, and clefs/keys. The
  resulting masks are composited over the page with per-layer toggles.
- The ~109 MB weights (oemer's MIT release) are downloaded out of band via
  `make models` and cached client-side; they are not committed.

**Known limitation:** segmentation currently runs on the main thread, so on the
WASM backend (no WebGPU) it pegs the CPU and the UI can't paint smooth progress.
Moving the pipeline into a Web Worker is the next responsiveness fix (deferred
from Phase 0; see [`PLAN.md`](./PLAN.md) §7).

Nothing transcribes notes yet. The next phases — staff structure, transcription,
assembly — are described in [`PLAN.md`](./PLAN.md) §7.

## Development

The only local requirements are `make` and `docker`; the toolchain (Bun, Biome,
tsc, Playwright) runs inside containers via `docker compose`.

```sh
make models           # download oemer ONNX weights -> public/models/ (once)
make build            # bun build src/ -> dist/ (+ ORT wasm, pdf worker, public/)
make dev              # build, then rebuild on change
make up / make down   # start/stop the static server on :3456
make format           # biome format --write
make lint             # biome lint
make typecheck        # tsc --noEmit
make unit-test        # bun test src lib
make integration-test # Playwright: cross-origin isolation + provider check
make pr-ready         # format, lint, typecheck, build, unit-test
```

Run `make pr-ready` before committing; CI (`.github/workflows/ci.yml`) runs the
same target. See [`AGENTS.md`](./AGENTS.md) for conventions and architecture
notes.

### Model weights & deployment

The ONNX weights (~109 MB, oemer's MIT release) are not committed. Locally,
`make models` downloads them into `public/models/`, which the dev server
(`scripts/serve.ts`) serves at `/models/<file>`.

For Netlify they are uploaded **once, out of band** to a site-wide
[Netlify Blobs](https://docs.netlify.com/blobs/overview/) store — not by the
build (the ~109 MB upload was too slow to do per deploy). Set
`NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` and run `make upload-models`: it
downloads the weights and runs `netlify blobs:set` per file in a Node container
(nothing is installed on the host). A function
(`netlify/functions/models.mts`) then streams them back same-origin at the same
`/models/<file>` URLs (same-origin is required under COEP). File names are
versioned so the URLs are immutable and cache forever; bump `MODEL_VERSION` in
`lib/models/manifest.ts` and re-run `make upload-models` to roll out new
weights.

## Licensing

This project's own source is intended to be permissively licensed. The
recognition pipeline is deliberately assembled from permissively-licensed parts:

| Component | Role | License |
|---|---|---|
| [oemer](https://github.com/BreezeWhite/oemer) | UNet segmentation models (`.onnx`) | MIT |
| [Polyphonic-TrOMR](https://github.com/NetEase/Polyphonic-TrOMR) | Staff-transcription transformer + vocabulary | Apache-2.0 |
| [homr](https://github.com/liebharc/homr) | Orchestration **reference only** | AGPL-3.0 |

`homr` is **reference only** — we read it to understand the orchestration and
reimplement clean-room in TypeScript. We do **not** copy its code or ship its
assets, because AGPL §13 (the network clause) would otherwise push this entire
app to AGPL. MIT/Apache notices from the components we do use will be retained.

**Caveat (non-blocking):** the training datasets behind these weights
(DeepScores, MUSCIMA/CvcMuscima) carry research/non-commercial-leaning terms, so
weight provenance is a grey area. Fine for a personal/open tool; confirm before
any commercial use.

## TODO

- **Revisit the integration tests once there is real behavior to verify.** Today
  `tests/integration/` holds only the Phase 0 cross-origin-isolation smoke check,
  which is kept out of `make pr-ready` (it needs the heavy Playwright browser
  image) and is therefore **not run in CI**. When an end-to-end path exists
  (e.g. Phase 3's "PDF in → MusicXML out" round-trip), either drop the
  placeholder spec or wire `make integration-test` into CI — as its own job, or
  folded into `pr-ready` — so the browser-level checks actually gate changes.
- Build the round-trip evaluation harness (engrave public-domain MusicXML →
  PDF → pipeline → diff recovered events) for an automatable accuracy metric.
- Work through the phased build order in [`PLAN.md`](./PLAN.md) §7:
  segmentation, staff structure, transcription, assembly, grand staff,
  robustness, polish.
