/**
 * End-to-end OMR integration tests.
 *
 * For each fixture (an image of printed sheet music from the musicxml.com
 * example set, see fixtures/README.md), this:
 *   1. runs the *actual* OMR pipeline headlessly in Node (onnxruntime-node,
 *      CPU, deterministic — see helpers/omr-pipeline.ts) to recover MusicXML;
 *   2. diffs the recovered MusicXML against the fixture's *source* score and
 *      asserts every difference is a codified affordance (see below); and
 *   3. renders that MusicXML with OpenSheetMusicDisplay in Chromium and asserts
 *      a screenshot of the engraving.
 *
 * Step 2 replaces the old "assert against a frozen snapshot of the recovered
 * output" approach. We do not commit the recovered MusicXML; instead each
 * fixture lists the specific, currently-expected ways its recovery differs from
 * the real score (EXPECTED_DIFFERENCES). The diff (helpers/musicxml-diff.ts) is a
 * two-way ratchet: an *uncodified* difference fails (a regression), and an
 * affordance that no longer matches any actual difference *also* fails — so when
 * you improve the OMR, the now-unnecessary affordance trips and you delete it,
 * raising the bar for good.
 *
 * The pipeline runs in Node rather than the browser on purpose: CPU inference is
 * deterministic (no WebGPU/WASM-thread variance), so these tests are slow but
 * not flaky. Only the OSMD rendering needs a real browser.
 *
 * The model weights are fetched once from Netlify (the same v2 weights the app
 * serves) and cached on disk; see helpers/omr-pipeline.ts. Run via
 * `make omr-integration-test`. Regenerate screenshots with `--update-snapshots`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import {
  type Affordance,
  assertDifferencesCodified,
  codify,
  parseScore,
} from "./helpers/musicxml-diff";
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

// The specific, currently-expected ways each fixture's recovered MusicXML
// differs from its source score. These ARE the assertion: the diff must match
// this list exactly (see assertDifferencesCodified). A difference not listed
// here fails the test (a regression or a newly-needed affordance); an affordance
// here that no longer matches a real difference ALSO fails (improve-and-delete).
//
// Universal, non-ratcheted differences (dropped lyrics/slurs/stems/…, divisions
// normalization, layout metadata) are stripped by the diff itself, not listed
// here — see NEVER_COMPARED_FEATURES in helpers/musicxml-diff.ts. What remains is
// only the genuine recognition gap. `chant` and `saltarello` recover every pitch
// and attribute except the meter; the dense scores also drop/mis-place notes.
const EXPECTED_DIFFERENCES: Record<string, Affordance[]> = {
  chant: [codify.timeSignature("senza-misura", "4/4")],
  saltarello: [codify.timeSignature("6/8", "4/4")],
  "mozart-piano-sonata": [
    codify.timeSignature("2/4", "4/4"),
    codify.missedNotes(19),
    codify.wrongNotes(11),
    codify.spuriousNotes(2),
    codify.wrongAccidentals(1),
  ],
  // binchois is currently skipped (below); these are kept ready for when the
  // pipeline improves enough to unskip it.
  binchois: [
    codify.timeSignature("3/4", "4/4"),
    codify.measureCount(34, 23),
    codify.clefCount(4, 2),
    codify.missedNotes(58),
    codify.wrongNotes(20),
    codify.spuriousNotes(29),
    codify.wrongAccidentals(3),
  ],
};

// Fixtures the pipeline cannot yet recognize well enough to pass. They are
// written as ordinary tests (source diff + OSMD screenshot) but SKIPPED, so each
// stays visible in the report as a standing reminder to improve the OMR rather
// than being quietly downgraded to a weaker assertion. Unskip a name once the
// pipeline produces correct, renderable output for it.
//
// TODO: improve the OMR until `binchois` passes, then drop it from this set.
// Today its recovery (see EXPECTED_DIFFERENCES above) drops a third of the
// measures and over-fills one, so OSMD/VexFlow refuses to engrave it — the same
// failure the editor's ScoreView surfaces.
const SKIPPED_FIXTURES = new Set<string>(["binchois"]);

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
    test.skip(
      SKIPPED_FIXTURES.has(name),
      "TODO: OMR is not yet good enough for this fixture — see SKIPPED_FIXTURES",
    );
    // CPU transcription of a full page is the slow part (~1 min/page).
    test.setTimeout(5 * 60 * 1000);

    const image = decodeImageFile(join(FIXTURES_DIRECTORY, `${name}.png`));
    const result = await recognizeImage(image, models);

    // The pipeline recovered something (guards against a silent empty result).
    expect(result.staffCount).toBeGreaterThan(0);
    expect(result.noteCount).toBeGreaterThan(0);
    expect(result.musicXml).not.toBe("");

    // 1) Content — diff the recovery against the source score and assert only
    //    the codified differences remain (regression + ratchet, see above).
    const source = parseScore(
      readFileSync(join(FIXTURES_DIRECTORY, `${name}.source.musicxml`), "utf8"),
    );
    const recovered = parseScore(result.musicXml);
    assertDifferencesCodified(source, recovered, EXPECTED_DIFFERENCES[name] ?? []);

    // 2) Rendered engraving — OSMD screenshot, with a small pixel tolerance for
    //    anti-aliasing. Generated in the pinned Playwright image so CI matches.
    await renderMusicXml(page, result.musicXml);
    await expect(page.locator("#score")).toHaveScreenshot(`${name}.png`, {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
    });
  });
}
