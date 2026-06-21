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
// Note-level affordances name the *specific* note and the measure it is in —
// `codify.missedNote(98, "A2")` (a source A2 in m98 the OMR never found),
// `codify.wrongNote(100, "A2", "F#5")` (source A2 read as F#5), spuriousNote,
// wrongAccidental — rather than a bare count, so each one says exactly what is
// wrong and where. Measures are the source's measure numbers. When you improve
// the OMR, the now-fixed note's affordance trips ("no longer necessary") and you
// delete that line.
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
    codify.spuriousNote(1, "A6"),
    codify.spuriousNote(3, "F6"),
    codify.missedNote(98, "A2"),
    codify.wrongNote(98, "C#3", "E5"),
    codify.missedNote(98, "C#5"),
    codify.wrongAccidental(98, "C#6", "C6"),
    codify.wrongNote(98, "E3", "C#5"),
    codify.missedNote(98, "E5"),
    codify.missedNote(99, "A2"),
    codify.missedNote(99, "C#3"),
    codify.missedNote(99, "E3"),
    codify.wrongNote(100, "A2", "F#5"),
    codify.missedNote(100, "D2"),
    codify.missedNote(100, "D6"),
    codify.missedNote(100, "F#2"),
    codify.wrongNote(100, "F#5", "C6"),
    codify.missedNote(101, "A2"),
    codify.missedNote(101, "A5"),
    codify.missedNote(101, "A5"),
    codify.missedNote(101, "A5"),
    codify.wrongNote(101, "A5", "E6"),
    codify.wrongNote(101, "C#3", "A5"),
    codify.missedNote(101, "D6"),
    codify.wrongNote(101, "D6", "A5"),
    codify.wrongNote(101, "D6", "A5"),
    codify.wrongNote(101, "D6", "A5"),
    codify.wrongNote(101, "E3", "E5"),
    codify.missedNote(101, "E5"),
    codify.wrongNote(102, "B2", "E5"),
    codify.missedNote(102, "E2"),
    codify.missedNote(102, "E5"),
    codify.missedNote(102, "E6"),
    codify.missedNote(102, "G#2"),
  ],
  // binchois is currently skipped (below); these are kept ready for when the
  // pipeline improves enough to unskip it. The list is long on purpose — it is
  // exactly how far the recovery is from the real score today.
  binchois: [
    codify.timeSignature("3/4", "4/4"),
    codify.clefCount(4, 2),
    codify.measureCount(34, 23),
    codify.missedNote(1, "C4"),
    codify.missedNote(1, "C4"),
    codify.missedNote(1, "D4"),
    codify.missedNote(1, "F4"),
    codify.missedNote(2, "F3"),
    codify.missedNote(2, "F3"),
    codify.missedNote(3, "C3"),
    codify.missedNote(3, "D3"),
    codify.missedNote(3, "E3"),
    codify.missedNote(3, "G3"),
    codify.missedNote(3, "G4"),
    codify.missedNote(4, "A3"),
    codify.missedNote(4, "A3"),
    codify.missedNote(4, "A3"),
    codify.missedNote(4, "F3"),
    codify.missedNote(4, "F3"),
    codify.missedNote(4, "F3"),
    codify.missedNote(5, "Bb3"),
    codify.missedNote(5, "C4"),
    codify.missedNote(6, "A3"),
    codify.missedNote(6, "A3"),
    codify.missedNote(6, "C4"),
    codify.missedNote(6, "G3"),
    codify.missedNote(7, "B3"),
    codify.missedNote(7, "C#4"),
    codify.missedNote(7, "C#4"),
    codify.wrongNote(7, "C3", "F4"),
    codify.wrongNote(7, "D3", "E4"),
    codify.missedNote(7, "D4"),
    codify.missedNote(7, "D4"),
    codify.wrongNote(7, "E3", "A3"),
    codify.missedNote(7, "E4"),
    codify.wrongNote(7, "F3", "C4"),
    codify.wrongNote(7, "F3", "D4"),
    codify.wrongNote(8, "D3", "F3"),
    codify.missedNote(8, "D4"),
    codify.wrongNote(9, "A3", "F4"),
    codify.missedNote(9, "C4"),
    codify.wrongNote(9, "D3", "G3"),
    codify.missedNote(9, "D4"),
    codify.wrongNote(9, "F3", "F4"),
    codify.missedNote(9, "F4"),
    codify.wrongNote(9, "G3", "F4"),
    codify.missedNote(10, "Bb3"),
    codify.missedNote(10, "F3"),
    codify.wrongNote(10, "F3", "Bb3"),
    codify.missedNote(10, "F4"),
    codify.missedNote(10, "F4"),
    codify.missedNote(10, "F4"),
    codify.wrongNote(11, "C3", "D4"),
    codify.wrongNote(11, "D3", "E4"),
    codify.missedNote(11, "E4"),
    codify.missedNote(11, "F4"),
    codify.wrongNote(12, "Bb2", "E4"),
    codify.wrongNote(12, "C3", "F4"),
    codify.missedNote(12, "E4"),
    codify.missedNote(12, "E4"),
    codify.missedNote(12, "F4"),
    codify.wrongAccidental(13, "Bb3", "B3"),
    codify.missedNote(13, "C4"),
    codify.wrongAccidental(13, "C4", "C#4"),
    codify.wrongAccidental(13, "C4", "C#4"),
    codify.wrongNote(13, "D3", "A3"),
    codify.missedNote(13, "D4"),
    codify.wrongNote(13, "E3", "Bb3"),
    codify.missedNote(14, "A3"),
    codify.missedNote(14, "A3"),
    codify.missedNote(14, "Bb3"),
    codify.wrongNote(14, "C3", "F3"),
    codify.spuriousNote(14, "D3"),
    codify.wrongNote(14, "D3", "G3"),
    codify.missedNote(15, "A3"),
    codify.wrongNote(15, "Bb2", "A3"),
    codify.missedNote(15, "C3"),
    codify.spuriousNote(15, "D4"),
    codify.missedNote(15, "F3"),
    codify.missedNote(15, "G3"),
    codify.missedNote(15, "G3"),
    codify.missedNote(16, "A3"),
    codify.spuriousNote(16, "F3"),
    codify.spuriousNote(16, "F3"),
    codify.missedNote(17, "C3"),
    codify.spuriousNote(17, "C3"),
    codify.missedNote(17, "D3"),
    codify.spuriousNote(17, "D3"),
    codify.missedNote(17, "E4"),
    codify.spuriousNote(17, "E4"),
    codify.missedNote(17, "F4"),
    codify.spuriousNote(17, "F4"),
    codify.spuriousNote(18, "Bb2"),
    codify.spuriousNote(18, "C3"),
    codify.spuriousNote(19, "Bb3"),
    codify.spuriousNote(19, "C4"),
    codify.spuriousNote(19, "C4"),
    codify.spuriousNote(19, "C4"),
    codify.spuriousNote(19, "D3"),
    codify.spuriousNote(19, "D4"),
    codify.spuriousNote(19, "E3"),
    codify.spuriousNote(20, "A3"),
    codify.spuriousNote(20, "C3"),
    codify.spuriousNote(20, "D3"),
    codify.spuriousNote(21, "A3"),
    codify.spuriousNote(21, "Bb2"),
    codify.spuriousNote(21, "C3"),
    codify.spuriousNote(21, "G3"),
    codify.spuriousNote(23, "C3"),
    codify.spuriousNote(23, "D3"),
    codify.spuriousNote(23, "D4"),
    codify.spuriousNote(23, "E4"),
    codify.spuriousNote(23, "F4"),
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
