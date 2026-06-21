/**
 * End-to-end OMR integration tests.
 *
 * For each fixture (an image of printed sheet music from the musicxml.com
 * example set, see fixtures/README.md), this:
 *   1. runs the *actual* OMR pipeline headlessly in Node (onnxruntime-node,
 *      CPU, deterministic — see helpers/omr-pipeline.ts) to recover MusicXML;
 *   2. asserts the recovered MusicXML against a committed snapshot; and
 *   3. renders that MusicXML with OpenSheetMusicDisplay in Chromium and asserts
 *      a screenshot of the engraving.
 *
 * The pipeline runs in Node rather than the browser on purpose: CPU inference is
 * deterministic (no WebGPU/WASM-thread variance), so these tests are slow but
 * not flaky. Only the OSMD rendering needs a real browser.
 *
 * The model weights are fetched once from Netlify (the same v2 weights the app
 * serves) and cached on disk; see helpers/omr-pipeline.ts. Run via
 * `make omr-integration-test`. Regenerate baselines with `--update-snapshots`.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  decodeImageFile,
  ensureModels,
  loadOmrModels,
  type OmrModels,
  recognizeImage,
} from "./helpers/omr-pipeline";
import { renderMusicXml } from "./helpers/render-osmd";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIRECTORY = join(here, "fixtures");

/** Every `<name>.png` in fixtures/ is a test case. */
function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIRECTORY)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -".png".length))
    .sort();
}

// Fixtures whose (imperfect) recovered MusicXML OpenSheetMusicDisplay cannot
// engrave — OMR over-fills a measure on these dense pages and VexFlow throws a
// RuntimeError, exactly as the editor's ScoreView surfaces. We still lock the
// recovered MusicXML as a regression baseline, but skip the screenshot. Move a
// name out of this set once the pipeline produces renderable output for it.
const CONTENT_ONLY_FIXTURES = new Set<string>(["binchois"]);

// Loading ~109 MB of weights and creating four inference sessions is the
// expensive setup; workers:1 (see the config) runs the fixtures in one worker,
// so beforeAll loads the models once and every test reuses them.
let models: OmrModels;

test.beforeAll(async () => {
  // Downloading the weights (first run on a machine) can be slow.
  test.setTimeout(10 * 60 * 1000);
  await ensureModels();
  models = await loadOmrModels();
});

for (const name of fixtureNames()) {
  test(`recognizes and renders ${name}`, async ({ page }) => {
    // CPU transcription of a full page is the slow part (~1 min/page).
    test.setTimeout(5 * 60 * 1000);

    const image = decodeImageFile(join(FIXTURES_DIRECTORY, `${name}.png`));
    const result = await recognizeImage(image, models);

    // The pipeline recovered something (guards against a silent empty result).
    expect(result.staffCount).toBeGreaterThan(0);
    expect(result.noteCount).toBeGreaterThan(0);
    expect(result.musicXml).not.toBe("");

    // 1) MusicXML content — committed, human-readable, diffable in review.
    expect(result.musicXml).toMatchSnapshot(`${name}.musicxml`);

    if (CONTENT_ONLY_FIXTURES.has(name)) {
      return;
    }

    // 2) Rendered engraving — OSMD screenshot, with a small pixel tolerance for
    //    anti-aliasing. Generated in the pinned Playwright image so CI matches.
    await renderMusicXml(page, result.musicXml);
    await expect(page.locator("#score")).toHaveScreenshot(`${name}.png`, {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    });
  });
}
