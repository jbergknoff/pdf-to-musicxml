/**
 * Token-dump harness for the OMR integration fixtures.
 *
 * Runs the *real* recognition pipeline (Node/CPU, the same path the
 * omr-integration tests use) over each fixture and prints, per staff:
 *   - the decoded opening attributes (clef / key / time);
 *   - the raw TrOMR rhythm token stream (so you can see whether a
 *     `timeSignature/N` token was emitted at all); and
 *   - the per-measure recovered note durations (in divisions) and the meter
 *     `inferMeterFromStaves` derives from them.
 *
 * This is the cheap way to confirm what the pipeline actually recovers without
 * eyeballing a whole MusicXML document — in particular to check the meter
 * predictions in import-image.spec.ts's EXPECTED_DIFFERENCES (does TrOMR emit a
 * meter, and what does rhythm inference produce?).
 *
 * It reuses the test helpers, so it needs the model weights. They are fetched
 * once from the deployed app and cached on disk (see ensureModels); a network
 * that blocks that host cannot run this. Run it inside lib/import-image so the
 * relative model path resolves:
 *
 *   cd lib/import-image && bun run scripts/dump-omr-tokens.ts [fixtureName ...]
 *
 * With no arguments it dumps every fixture; pass names (e.g. `saltarello mozart-
 * piano-sonata`) to limit it.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DIVISIONS, noteDivisions } from "../lib/assembly/durations";
import { inferMeterFromStaves } from "../lib/assembly/meter";
import type { NoteEvent, Transcription } from "../lib/types";
import {
  decodeImageFile,
  ensureModels,
  loadOmrModels,
  type OmrModels,
  recognizeImage,
  type StaffDetectionMode,
} from "../tests/integration/helpers/omr-pipeline";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIRECTORY = join(here, "../tests/integration/fixtures");

// Staff-detection path to exercise (mirrors the worker's OmrConfig). Defaults to
// the pipeline default; set OMR_STAFF_DETECTION=model to A/B the oemer UNet path.
const STAFF_DETECTION: StaffDetectionMode =
  process.env.OMR_STAFF_DETECTION === "model" ? "model" : "classical";

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIRECTORY)
    .filter((name) => name.endsWith(".png"))
    .map((name) => name.slice(0, -".png".length))
    .sort();
}

/** Total written divisions per measure for one staff (chord tails add no time). */
function measureLengths(notes: NoteEvent[]): Map<number, number> {
  const lengths = new Map<number, number>();
  for (const note of notes) {
    if (note.chord || note.grace) {
      continue;
    }
    lengths.set(
      note.measureIndex,
      (lengths.get(note.measureIndex) ?? 0) + noteDivisions(note),
    );
  }
  return lengths;
}

function formatAttributes(transcription: Transcription): string {
  const { clef, keyFifths, time } = transcription.attributes;
  const clefText = clef ? `${clef.sign}${clef.line}` : "—";
  const keyText = keyFifths === undefined ? "—" : `${keyFifths}`;
  const timeText = time ? `${time.beats}/${time.beatType}` : "— (none emitted)";
  return `clef ${clefText} · key ${keyText} · time ${timeText}`;
}

function dumpStaff(transcription: Transcription, index: number): void {
  console.log(`  staff ${index + 1}: ${formatAttributes(transcription)}`);

  // Whether a time-signature token appeared at all is the key question for the
  // meter affordances — surface it explicitly.
  const timeTokens = transcription.rawRhythm.filter((token) =>
    token.startsWith("timeSignature/"),
  );
  console.log(
    `    timeSignature tokens: ${
      timeTokens.length > 0 ? timeTokens.join(", ") : "(none)"
    }`,
  );

  const lengths = [...measureLengths(transcription.notes).entries()].sort(
    (a, b) => a[0] - b[0],
  );
  const lengthText = lengths
    .map(([measure, length]) => `m${measure}=${length}`)
    .join(" ");
  console.log(`    measure lengths (divisions, quarter=${DIVISIONS}): ${lengthText}`);
  console.log(`    raw rhythm: ${transcription.rawRhythm.join(" ")}`);
}

async function dumpFixture(name: string, models: OmrModels): Promise<void> {
  console.log(`\n=== ${name} (staffDetection=${STAFF_DETECTION}) ===`);
  const image = decodeImageFile(join(FIXTURES_DIRECTORY, `${name}.png`));
  const result = await recognizeImage(image, models, STAFF_DETECTION);
  console.log(
    `staves: ${result.staffCount} · notes: ${result.noteCount} · ` +
      `xml: ${result.musicXml.length > 0 ? "built" : "(empty)"}`,
  );

  for (let index = 0; index < result.transcriptions.length; index++) {
    dumpStaff(result.transcriptions[index], index);
  }

  // The meter the builder would infer for this fixture (shared across staves),
  // mirroring buildScore: every staff's measures count toward the tally.
  const inferred = inferMeterFromStaves(
    result.transcriptions.map((transcription) => transcription.notes),
  );
  console.log(
    `  inferred meter: ${inferred ? `${inferred.beats}/${inferred.beatType}` : "(default 4/4)"}`,
  );
}

async function main(): Promise<void> {
  const requested = process.argv.slice(2);
  const names =
    requested.length > 0
      ? requested
      : fixtureNames();

  await ensureModels();
  const models = await loadOmrModels();
  for (const name of names) {
    await dumpFixture(name, models);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
