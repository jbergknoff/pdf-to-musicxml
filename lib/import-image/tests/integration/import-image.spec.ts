/**
 * End-to-end OMR integration tests.
 *
 * For each fixture (an image of printed sheet music from the musicxml.com
 * example set, see fixtures/README.md), this:
 *   1. runs the *actual* OMR pipeline headlessly in Node (classical CV path,
 *      no ONNX models required — see helpers/omr-pipeline.ts) to recover
 *      MusicXML;
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
 * The pipeline uses classical (model-free) staff detection and transcription, so
 * no ONNX weights are downloaded or loaded. Run via `make omr-integration-test`.
 * Regenerate screenshots with `--update-snapshots`.
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
// only the genuine recognition gap.
const EXPECTED_DIFFERENCES: Record<string, Affordance[]> = {
  chant: [
    codify.timeSignature("senza-misura", "4/4"),
    codify.spuriousNote(1, "A3"),
    codify.spuriousNote(1, "D6"),
    codify.spuriousNote(1, "D6"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G3"),
    codify.spuriousNote(1, "G5"),
  ],
  "mozart-piano-sonata": [
    codify.key(3, -3),
    codify.timeSignature("2/4", "4/4"),
    codify.spuriousNote(5, "F5"),
    // m98
    codify.missedNote(98, "A2"),
    codify.missedNote(98, "A3"),
    codify.missedNote(98, "A3"),
    codify.missedNote(98, "A3"),
    codify.missedNote(98, "A3"),
    codify.missedNote(98, "A5"),
    codify.missedNote(98, "C#3"),
    codify.missedNote(98, "C#5"),
    codify.missedNote(98, "C#6"),
    // m99
    codify.missedNote(99, "A2"),
    codify.missedNote(99, "A3"),
    codify.missedNote(99, "A3"),
    codify.missedNote(99, "A3"),
    codify.wrongNote(99, "A3", "E3"),
    codify.missedNote(99, "B5"),
    codify.missedNote(99, "B5"),
    codify.missedNote(99, "C#3"),
    codify.missedNote(99, "C#6"),
    codify.missedNote(99, "C#6"),
    codify.missedNote(99, "C#6"),
    codify.missedNote(99, "C#6"),
    codify.missedNote(99, "D6"),
    codify.missedNote(99, "D6"),
    // m100
    codify.missedNote(100, "A2"),
    codify.missedNote(100, "D2"),
    codify.wrongNote(100, "D3", "A5"),
    codify.wrongNote(100, "D3", "A5"),
    codify.wrongNote(100, "D3", "G5"),
    codify.wrongNote(100, "D3", "G5"),
    codify.missedNote(100, "D6"),
    codify.missedNote(100, "F#2"),
    codify.wrongNote(100, "F#5", "E3"),
    // m101
    codify.missedNote(101, "A2"),
    codify.missedNote(101, "A3"),
    codify.missedNote(101, "A3"),
    codify.missedNote(101, "A3"),
    codify.missedNote(101, "A3"),
    codify.missedNote(101, "C#3"),
    codify.missedNote(101, "C#6"),
    codify.missedNote(101, "C#6"),
    codify.wrongAccidental(101, "C#6", "C6"),
    codify.wrongNote(101, "C#6", "E5"),
    codify.missedNote(101, "D6"),
    codify.wrongNote(101, "D6", "A5"),
    codify.wrongNote(101, "D6", "A5"),
    codify.missedNote(101, "E3"),
    codify.missedNote(101, "E5"),
    // m102
    codify.missedNote(102, "B2"),
    codify.missedNote(102, "B5"),
    codify.missedNote(102, "E2"),
    codify.missedNote(102, "E3"),
    codify.missedNote(102, "E3"),
    codify.missedNote(102, "E3"),
    codify.missedNote(102, "E3"),
    codify.missedNote(102, "E5"),
    codify.missedNote(102, "E6"),
    codify.missedNote(102, "G#2"),
    codify.missedNote(102, "G#5"),
  ],
  saltarello: [
    codify.timeSignature("6/8", "4/4"),
    codify.clefCount(1, 2),
    codify.measureCount(22, 16),
    // m1
    codify.missedNote(1, "A3"),
    codify.missedNote(1, "A3"),
    codify.missedNote(1, "B3"),
    codify.missedNote(1, "B3"),
    codify.missedNote(1, "C4"),
    codify.missedNote(1, "G3"),
    // m2
    codify.missedNote(2, "B3"),
    codify.missedNote(2, "C4"),
    codify.missedNote(2, "C4"),
    codify.missedNote(2, "D4"),
    codify.missedNote(2, "G3"),
    // m3
    codify.missedNote(3, "A3"),
    codify.missedNote(3, "A3"),
    codify.missedNote(3, "B3"),
    codify.missedNote(3, "B3"),
    codify.missedNote(3, "C4"),
    codify.wrongNote(3, "G3", "G4"),
    // m4
    codify.wrongNote(4, "B3", "C5"),
    codify.wrongNote(4, "C4", "A4"),
    codify.wrongNote(4, "C4", "A4"),
    codify.wrongNote(4, "D4", "B4"),
    codify.wrongNote(4, "E4", "A4"),
    // m5
    codify.wrongNote(5, "C4", "B4"),
    codify.missedNote(5, "D4"),
    codify.missedNote(5, "E4"),
    codify.missedNote(5, "F4"),
    // m6
    codify.missedNote(6, "C4"),
    codify.wrongNote(6, "D4", "B4"),
    codify.missedNote(6, "E4"),
    codify.wrongNote(6, "G4", "A4"),
    // m7
    codify.wrongNote(7, "A3", "C5"),
    codify.wrongNote(7, "B3", "B4"),
    codify.wrongNote(7, "C4", "A4"),
    codify.wrongNote(7, "C4", "C5"),
    codify.wrongNote(7, "E4", "B4"),
    // m8
    codify.wrongNote(8, "A3", "B4"),
    codify.wrongNote(8, "A3", "F5"),
    codify.wrongNote(8, "E4", "C5"),
    codify.wrongNote(8, "E4", "D5"),
    // m9
    codify.wrongNote(9, "A3", "B4"),
    codify.wrongNote(9, "B3", "A4"),
    codify.wrongNote(9, "B3", "D5"),
    codify.wrongNote(9, "C4", "B4"),
    codify.wrongNote(9, "C4", "C5"),
    codify.wrongNote(9, "C4", "F5"),
    // m10
    codify.wrongNote(10, "B3", "D5"),
    codify.wrongNote(10, "C4", "C5"),
    codify.wrongNote(10, "C4", "G4"),
    codify.wrongNote(10, "D4", "G4"),
    codify.wrongNote(10, "D4", "G4"),
    // m11
    codify.wrongNote(11, "A3", "A4"),
    codify.wrongNote(11, "B3", "C5"),
    codify.wrongNote(11, "C4", "B2"),
    codify.wrongNote(11, "D4", "B4"),
    codify.wrongNote(11, "E4", "B4"),
    // m12
    codify.wrongNote(12, "C4", "B4"),
    codify.wrongNote(12, "D4", "B4"),
    codify.wrongNote(12, "E4", "D3"),
    // m13
    codify.wrongNote(13, "A3", "D3"),
    codify.wrongNote(13, "B3", "C3"),
    codify.wrongNote(13, "B3", "D3"),
    codify.missedNote(13, "C4"),
    codify.wrongNote(13, "C4", "C3"),
    // m14
    codify.wrongNote(14, "A3", "B5"),
    codify.wrongNote(14, "B3", "C5"),
    codify.wrongNote(14, "C4", "B4"),
    codify.wrongNote(14, "G3", "A4"),
    codify.wrongNote(14, "G3", "D3"),
    // m15
    codify.wrongNote(15, "A3", "B4"),
    codify.wrongNote(15, "A3", "E3"),
    codify.wrongNote(15, "B3", "B4"),
    codify.wrongNote(15, "B3", "C3"),
    codify.wrongNote(15, "C4", "D3"),
    codify.wrongNote(15, "G3", "D5"),
    // m16
    codify.spuriousNote(16, "A4"),
    codify.wrongNote(16, "B3", "D3"),
    codify.wrongNote(16, "C4", "B4"),
    codify.wrongNote(16, "C4", "B4"),
    codify.wrongNote(16, "D4", "A4"),
    codify.wrongNote(16, "E4", "B4"),
    // m17
    codify.wrongNote(17, "C4", "G4"),
    codify.wrongNote(17, "D4", "A4"),
    codify.wrongNote(17, "E4", "B4"),
    codify.wrongNote(17, "F4", "A4"),
    // m18
    codify.wrongNote(18, "C4", "B4"),
    codify.missedNote(18, "D4"),
    codify.missedNote(18, "E4"),
    // m19
    codify.missedNote(19, "A3"),
    codify.missedNote(19, "B3"),
    codify.missedNote(19, "C4"),
    codify.missedNote(19, "C4"),
    codify.missedNote(19, "E4"),
    // m20
    codify.missedNote(20, "A3"),
    codify.missedNote(20, "A3"),
    codify.missedNote(20, "E4"),
    codify.missedNote(20, "E4"),
    // m21
    codify.missedNote(21, "A3"),
    codify.missedNote(21, "B3"),
    codify.missedNote(21, "B3"),
    codify.missedNote(21, "C4"),
    codify.missedNote(21, "C4"),
    codify.missedNote(21, "C4"),
    // m22
    codify.missedNote(22, "B3"),
    codify.missedNote(22, "C4"),
    codify.missedNote(22, "C4"),
    codify.missedNote(22, "D4"),
    codify.missedNote(22, "D4"),
  ],
};

// Fixtures the pipeline cannot yet recognize well enough to pass. They are
// written as ordinary tests (source diff + OSMD screenshot) but SKIPPED, so each
// stays visible in the report as a standing reminder to improve the OMR rather
// than being quietly downgraded to a weaker assertion. Unskip a name once the
// pipeline produces correct, renderable output for it.
//
// TODO: improve the OMR until `binchois` passes, then drop it from this set.
// The score is medieval three-voice polyphony; the classical CV path has not
// been validated against it yet and may produce malformed output that
// OSMD/VexFlow refuses to engrave.
const SKIPPED_FIXTURES = new Set<string>(["binchois"]);

for (const name of fixtureNames()) {
  test(`recognizes and renders ${name}`, async ({ page }) => {
    test.skip(
      SKIPPED_FIXTURES.has(name),
      "TODO: OMR is not yet good enough for this fixture — see SKIPPED_FIXTURES",
    );
    // Classical CV transcription is fast; no model weights needed.
    test.setTimeout(5 * 60 * 1000);

    const image = decodeImageFile(join(FIXTURES_DIRECTORY, `${name}.png`));
    // Classical staff detection and transcription — no ONNX models required.
    const result = await recognizeImage(image, null);

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
