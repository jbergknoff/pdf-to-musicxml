# pdf-to-musicxml — Design & Build Plan

Client-side Optical Music Recognition (OMR): convert a PDF or image of printed
sheet music into MusicXML, entirely in the browser. No image leaves the device.

This document is the handoff from the planning session. It is self-contained:
a fresh session scoped to this repo can read it and start at Phase 0.

## 1. Goal & constraints

- **In:** a PDF or image (PNG/JPG) of printed Western music notation.
  **Out:** a downloadable `.musicxml` file.
- **100% client-side.** All inference runs in the browser via ONNX Runtime Web;
  no network round-trip for the image. Hostable as static files.
- **Toolchain: bun-only** (runtime, package manager, bundler, test runner).
  No Vite — `bun build` + a small `Bun.serve` dev server cover it. Vite is the
  fallback *only* if bun's bundler can't handle ORT Web's threaded WASM glue
  (decided in Phase 0).
- **Target output:** piano grand staff, reached in phases (monophonic single
  staff first).

## 2. Model & licensing strategy

The proven high-accuracy design (homr's) is **segment → locate staves →
transcribe each staff with a transformer → assemble MusicXML**. We re-derive it
from permissively-licensed parts and keep the AGPL project at arm's length.

| Project | Role | License | Use here |
|---|---|---|---|
| **oemer** (BreezeWhite) | UNet segmentation models (staffline mask + symbol mask), already shipped as `.onnx` | **MIT** | Use the models directly. |
| **Polyphonic-TrOMR** (NetEase) | Transformer that reads one cropped staff → multi-head token sequence (rhythm/pitch/accidental) | **Apache-2.0** | Use the model + vocabulary. |
| **homr** (liebharc) | Combines the above + grand-staff merging | **AGPL-3.0** | **Reference only.** Read to understand orchestration; reimplement clean-room in TypeScript. Do NOT copy code or ship its assets — AGPL §13 (network clause) would push the whole app to AGPL. |

Model files:
- oemer ships `.onnx` (auto-downloaded on first run, or from its GitHub Releases
  `checkpoints` tag): `1st_*` → UNet "unet_big", `2nd_*` → "seg_net".
- A TrOMR `.onnx` + its **vocabulary files** (data, not AGPL code) are needed for
  transcription decoding.
- Total tens of MB. Verify ORT Web opset compatibility early; apply int8 dynamic
  quantization to shrink downloads. Host as static assets or on Releases/HF and
  cache in Cache Storage / IndexedDB keyed by content hash (offline + instant
  repeat visits).

Caveat (non-blocking): training datasets (DeepScores, MUSCIMA/CvcMuscima) carry
research/non-commercial-leaning terms; weight provenance is a grey area. Fine for
a personal/open tool; confirm before any commercial use.

## 3. Pipeline

```
PDF/Image
  └─▶ Input & preprocess   (pdf.js raster ~300 DPI, grayscale, binarize, deskew)  [algorithm]
       └─▶ Segmentation     (oemer UNet ×2 → staffline + symbol masks, tiled)      [ONNX/CNN]
            └─▶ Staff structure (stafflines, unit size, systems, braces)            [algorithm]
                 └─▶ Crop staves (normalized strips, height from unit size)         [algorithm]
                      └─▶ Transcribe (TrOMR → token sequence per staff)             [ONNX/Transformer]
                           └─▶ Decode tokens (vocab → pitch/dur/accidental)         [algorithm]
                                └─▶ Assemble (measures, voices, grand-staff)        [algorithm]
                                     └─▶ Emit MusicXML + download                   [algorithm]
```

Segmentation tells us *where* the staves are; the transformer does the *reading*.
Both export to ONNX and run in ORT Web; neither needs a server GPU.

### Stage notes
- **Input/preprocess:** pdf.js → one raster per page; grayscale; Otsu (adaptive
  if uneven); deskew via horizontal-projection angle search. Phone-photo
  *dewarping* deferred to Phase 6 — v1 assumes clean PDFs/flatbed scans.
- **Segmentation:** tile into overlapping patches (memory control), run per tile,
  stitch masks. Confirm input layout (NCHW vs NHWC) and normalization.
- **Staff structure:** projection → staffline peaks → group into 5-line staves →
  estimate **unit size** (interline spacing, the scale reference for everything).
  Group staves into systems; detect left-margin braces/brackets to merge into
  grand-staff parts.
- **Transcription:** crop each staff to normalized height, feed TrOMR; it emits
  separate rhythm/pitch/accidental token streams (its polyphony representation).
- **Decode + assembly:** reconstruct notes/chords/rests, durations, clef, key,
  time sig; carry accidentals within a measure; split on barline tokens; group
  beams; align grand-staff pairs into one part with two staves; build MusicXML.
  This decoder is what homr does in AGPL Python — reimplement from the vocabulary
  spec + the TrOMR paper.

## 4. Repository layout

`lib/` is framework-agnostic and runtime-agnostic (runs in both bun/node with
`onnxruntime-node` for tests and the browser with `onnxruntime-web`); `src/` is
the UI. The runtime is injected via an interface so `lib/` never imports a
concrete ORT package.

```
pdf-to-musicxml/
  lib/
    input/        pdf-to-image.ts, decode-image.ts, preprocess.ts
    segmentation/ unet-session.ts, tiling.ts, masks.ts
    staves/       staffline-detection.ts, unit-size.ts, system-grouping.ts, grand-staff.ts
    transcription/staff-crop.ts, tromr-session.ts, vocabulary.ts, decode-tokens.ts
    assembly/     measures.ts, voices.ts, accidentals.ts, musicxml-builder.ts
    runtime/      inference-backend.ts   # injected interface; impls in src/ + tests
    pipeline.ts                          # orchestrates stages, emits progress
    types.ts
  src/
    main.tsx, App.tsx
    runtime/web-backend.ts               # onnxruntime-web impl
    worker/omr.worker.ts                 # runs lib/pipeline off the main thread
    components/ FileDrop.tsx, ProgressView.tsx, ScorePreview.tsx, DownloadBar.tsx
    models/registry.ts                   # URLs + content hashes + cache
  public/
    models/*.onnx                        # or fetched from Releases/HF + cached
    ort/*.wasm
  scripts/build.ts, scripts/dev-server.ts
  index.html, Makefile, package.json, netlify.toml / public/_headers
  tests/fixtures/                        # PDFs + ground-truth MusicXML
```

Conventions (carried from the sibling piano-practice repo): full words in names
(no abbreviations), braces around all conditional/loop bodies, components
PascalCase / everything else kebab-case, commit `bun.lock` with package.json.

## 5. Tech stack

| Concern | Choice | Notes |
|---|---|---|
| Build/SPA | bun + Preact + TS | `bun build` bundles; bun dev server for HMR-ish loop. |
| Inference | `onnxruntime-web` | WebGPU EP, WASM fallback; ship `.wasm` assets. |
| PDF raster | `pdfjs-dist` | pages → canvas at ~300 DPI. |
| Image preprocessing | hand-rolled canvas ops | avoid OpenCV.js (~8 MB). |
| Result preview | `opensheetmusicdisplay` | render output so the user verifies before download. |
| Off-main-thread | Web Worker | model loading + inference + staff detection run in a worker, streaming progress; decode stays on the main thread (`src/worker/`). |

### Deployment specifics (critical)
- **WebGPU first, WASM fallback:** `executionProviders: ['webgpu','wasm']`.
- **COOP/COEP headers required** for WASM threads (`SharedArrayBuffer`):
  `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy:
  require-corp`. Set in dev (the bun dev server) AND prod (`netlify.toml` /
  `_headers`). Plain GitHub Pages can't set headers — use a host that can or the
  `coi-serviceworker` shim.

## 6. Phase 0 scaffold (concrete — bun-only)

Goal: prove `bun build` bundles ORT Web's threaded WASM and the page is
cross-origin-isolated. Acceptance: page shows `crossOriginIsolated: true`,
`WebGPU available: true` (Chrome/Edge), provider resolves to `webgpu` (or cleanly
falls back to `wasm`), and no console errors loading `.wasm` from `/ort/`.

### package.json
```jsonc
{
  "name": "pdf-to-musicxml",
  "private": true,
  "type": "module",
  "dependencies": {
    "preact": "^10",
    "onnxruntime-web": "^1.20",
    "pdfjs-dist": "^4",
    "opensheetmusicdisplay": "^1.9"
  },
  "devDependencies": {
    "onnxruntime-node": "^1.20",
    "typescript": "^5"
  }
}
```

### Makefile
```make
build:        ; bun run scripts/build.ts
dev:          ; bun run scripts/dev-server.ts
typecheck:    ; bunx tsc --noEmit
unit-test:    ; bun test
pr-ready: typecheck build unit-test
```

### scripts/build.ts
```ts
import { cp } from "node:fs/promises";

await Bun.build({
  entrypoints: ["src/main.tsx"],
  outdir: "dist",
  target: "browser",
  minify: true,
});
// ORT Web fetches its wasm at runtime; serve them under /ort/.
await cp("node_modules/onnxruntime-web/dist", "dist/ort", {
  recursive: true,
  filter: (p) => p.endsWith(".wasm") || p.endsWith(".mjs"),
});
await cp("index.html", "dist/index.html");
```

### scripts/dev-server.ts
```ts
import { file } from "bun";

const ISOLATION = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

Bun.serve({
  port: 5173,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === "/" ? "/index.html" : url.pathname;
    if (path.startsWith("/ort/")) {
      path = `/node_modules/onnxruntime-web/dist/${path.slice(5)}`;
    } else if (!path.startsWith("/dist/")) {
      path = path.endsWith(".html") ? path : `/dist${path}`;
    }
    const f = file(`.${path}`);
    return (await f.exists())
      ? new Response(f, { headers: ISOLATION })
      : new Response("not found", { status: 404, headers: ISOLATION });
  },
});
console.log("http://localhost:5173 (run `make build` first / on change)");
```

### lib/runtime/inference-backend.ts
```ts
export interface Tensor { data: Float32Array; dims: number[]; }
export interface InferenceSession {
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}
export interface InferenceBackend {
  /** execution provider actually selected, e.g. "webgpu" | "wasm" | "cpu" */
  readonly provider: string;
  createSession(modelBytes: Uint8Array): Promise<InferenceSession>;
}
```

### src/runtime/web-backend.ts
```ts
import * as ort from "onnxruntime-web";
import type { InferenceBackend } from "../../lib/runtime/inference-backend";

ort.env.wasm.wasmPaths = "/ort/";

export async function createWebBackend(): Promise<InferenceBackend> {
  const provider = "gpu" in navigator ? "webgpu" : "wasm";
  return {
    provider,
    async createSession(modelBytes) {
      const session = await ort.InferenceSession.create(modelBytes, {
        executionProviders: [provider, "wasm"],
      });
      return {
        async run(feeds) {
          return (await session.run(feeds as any)) as any;
        },
      };
    },
  };
}
```

### src/main.tsx
```tsx
import { render } from "preact";
import { createWebBackend } from "./runtime/web-backend";

async function App() {
  const backend = await createWebBackend();
  return (
    <pre>
      crossOriginIsolated: {String(crossOriginIsolated)}{"\n"}
      WebGPU available:    {String("gpu" in navigator)}{"\n"}
      selected provider:   {backend.provider}
    </pre>
  );
}
App().then((node) => render(node, document.getElementById("app")!));
```

### index.html
`<div id="app"></div>` + `<script type="module" src="/dist/main.js"></script>`.

## 7. Phased build order

Status: **Phases 0–2 are done** (see `AGENTS.md` for the as-built notes).

| Phase | Deliverable | De-risks |
|---|---|---|
| **0 — Scaffold** ✅ | bun SPA; ORT Web reports provider; COOP/COEP true. | toolchain, isolation, WebGPU path. |
| **1 — Segmentation** ✅ | oemer UNets running; masks overlaid on page; PDF/image decode. | model opset/layout/quantization, tiling, memory, perf. **Biggest infra risk — front-loaded.** |
| **2 — Staff structure** ✅ | detected staves + unit size drawn on page. | pure algorithm; high confidence. |
| **3 — Mono POC** | one staff → TrOMR → minimal single-voice MusicXML → OSMD preview + download. **First end-to-end output.** | token decoding — biggest correctness unknown. |
| **4 — Full single staff** | key/time sig, rests, accidentals, beams, multi-measure, multi-page. | assembly fidelity. |
| **5 — Grand staff** | brace detection, paired staves, two-staff part, per-staff voices. | piano target reached. |
| **6 — Robustness** | phone-photo dewarp/deskew, error handling, quantization + perf tuning. | real-world inputs. |
| **7 — Polish** | caching, offline service worker, download/correction UX. | production feel. |

Deferred / not-yet-done from the early phases (pull in before or alongside Phase 3):
- **Web Worker** — done. Model loading + segmentation + staff detection run in `src/worker/omr.worker.ts` (driven by `omr-client.ts`), so the heavy WASM pass no longer pegs the UI. File decode stays on the main thread (pdf.js / canvas are DOM-bound).
- **PDF→canvas decode** landed in Phase 1 (not Phase 0) — done.
- **int8 quantization** of the weights (download-size/perf) — not done; revisit in Phase 6.

## 8. Testing & evaluation

- **Unit tests** (bun + `onnxruntime-node`) on pure stages: staff detection over
  synthetic masks, token→event decoding, measure/voice assembly, MusicXML builder.
- **Round-trip eval harness:** take public-domain MusicXML (engrave via MuseScore
  → PDF), run the pipeline, diff recovered events against the original. Compare
  *musical content* (ordered pitch/duration/measure events), not raw XML strings.
  Gives an automatable accuracy metric + regression protection.
- Fixtures from IMSLP / MuseScore public-domain scores in `tests/fixtures/`.

## 9. Key risks

1. **ORT Web opset gaps** — UNet/transformer ops may be unsupported on WebGPU
   (→ WASM) or need re-export. Prove inference in Phase 1 before building on it.
2. **TrOMR decoder without homr's code** — reimplementing multi-head decode from
   vocab + paper is the biggest correctness unknown. Budget Phase 3; build the
   round-trip eval harness alongside.
3. **Real-world accuracy** — scans/photos degrade results; OMR is never perfect.
   Ship the OSMD preview so users verify; in-app correction is post-v1.
4. **Licensing hygiene** — homr stays reference-only; retain MIT/Apache notices;
   confirm dataset/weight provenance before any commercial use.

## 10. Future option

Emerging **end-to-end full-page pianoform OMR** (single model, no staff-cropping
front end) could collapse stages 2–5 into one model. No permissive ONNX weights
exist yet — track it, don't bet v1 on it.

## Sources
- oemer: https://github.com/BreezeWhite/oemer  (MIT)
- homr: https://github.com/liebharc/homr  (AGPL-3.0, reference only)
- Polyphonic-TrOMR: https://github.com/NetEase/Polyphonic-TrOMR  (Apache-2.0)
- TrOMR paper: https://ar5iv.labs.arxiv.org/html/2308.09370
- OMR overview: https://en.wikipedia.org/wiki/Optical_music_recognition
