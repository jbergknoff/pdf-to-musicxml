/**
 * Reads the MusicXML files produced by run-homr.py and diffs each one against
 * its fixture's source score, using the same engine as the OMR integration
 * tests (helpers/musicxml-diff.ts). Prints a side-by-side comparison of HOMR's
 * accuracy versus our pipeline's codified affordances.
 *
 * Run via `make homr-comparison` (which runs run-homr.py first, then this).
 * The output is an informational report, not a pass/fail test.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeDifferences,
  parseScore,
  type Difference,
} from "../tests/integration/helpers/musicxml-diff";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(here, "../tests/integration/fixtures");
const HOMR_OUTPUT_DIR = join(here, "../tmp/homr-output");

const ALL_FIXTURES = [
  "chant",
  "saltarello",
  "mozart-piano-sonata",
  "binchois",
  "gabriels-bell",
  "elgar-ave-verum",
];

// Our pipeline's codified difference counts from import-image.spec.ts
// (EXPECTED_DIFFERENCES). These are not re-run here — the spec is the live
// source; these are a snapshot for quick reference in this report.
const OUR_COUNTS: Record<string, number | "skipped"> = {
  chant: 1, // time: senza-misura → 4/4
  saltarello: 1, // time: 6/8 → 3/4
  "mozart-piano-sonata": 3, // 1 wrong-accidental + 2 wrong-note
  binchois: "skipped", // multi-part vocal score; single-part pipeline flattens it
  "gabriels-bell": "skipped", // two-part auto-conversion; same multi-part issue
  "elgar-ave-verum": "skipped", // SATB+organ; three parts, three pages
};

const ATTRIBUTE_KINDS = new Set([
  "time-signature",
  "key",
  "clef-count",
  "clefs",
  "measure-count",
]);

function isAttribute(d: Difference): boolean {
  return ATTRIBUTE_KINDS.has(d.kind);
}

function formatDifference(d: Difference): string {
  switch (d.kind) {
    case "time-signature":
      return `time: ${d.source} → ${d.recovered}`;
    case "key":
      return `key: ${d.source} → ${d.recovered} fifths`;
    case "clef-count":
      return `clef count: ${d.source} → ${d.recovered}`;
    case "clefs":
      return `clefs: ${d.source} → ${d.recovered}`;
    case "measure-count":
      return `measure count: ${d.source} → ${d.recovered}`;
    case "missed-note":
      return `missed ${d.pitch} (m${d.measure})`;
    case "wrong-note":
      return `wrong note m${d.measure}: ${d.source} → ${d.recovered}`;
    case "spurious-note":
      return `spurious ${d.pitch} (m${d.measure})`;
    case "wrong-accidental":
      return `wrong accidental m${d.measure}: ${d.source} → ${d.recovered}`;
  }
}

// Print the first NOTE_DISPLAY_LIMIT note-level differences, then a "… N more"
// line. Attribute-level differences are always shown (there are at most five).
const NOTE_DISPLAY_LIMIT = 15;

function printDifferenceList(differences: Difference[]): void {
  const attributeDiffs = differences.filter(isAttribute);
  const noteDiffs = differences.filter((d) => !isAttribute(d));
  for (const d of attributeDiffs) {
    console.log(`      • ${formatDifference(d)}`);
  }
  for (const d of noteDiffs.slice(0, NOTE_DISPLAY_LIMIT)) {
    console.log(`      • ${formatDifference(d)}`);
  }
  if (noteDiffs.length > NOTE_DISPLAY_LIMIT) {
    console.log(`      … and ${noteDiffs.length - NOTE_DISPLAY_LIMIT} more note difference(s)`);
  }
}

type HomrResult =
  | { status: "missing" }
  | { status: "error"; message: string }
  | { status: "ok"; count: number; differences: Difference[] };

function computeHomrResult(name: string): HomrResult {
  const homrPath = join(HOMR_OUTPUT_DIR, `${name}.musicxml`);
  if (!existsSync(homrPath)) {
    return { status: "missing" };
  }
  const sourcePath = join(FIXTURES_DIR, `${name}.source.musicxml`);
  try {
    const source = parseScore(readFileSync(sourcePath, "utf8"));
    const recovered = parseScore(readFileSync(homrPath, "utf8"));
    const differences = computeDifferences(source, recovered);
    return { status: "ok", count: differences.length, differences };
  } catch (error) {
    return { status: "error", message: String(error) };
  }
}

function main(): void {
  const hr = "═".repeat(70);
  console.log(hr);
  console.log("HOMR accuracy comparison (https://github.com/liebharc/homr)");
  console.log("Same source scores and diff engine as the OMR integration tests.");
  console.log(hr);
  console.log();

  const summaryRows: {
    name: string;
    homr: number | "missing" | "error";
    ours: number | "skipped";
  }[] = [];

  for (const name of ALL_FIXTURES) {
    const ours = OUR_COUNTS[name];
    const homrResult = computeHomrResult(name);

    console.log(`${name}:`);

    if (homrResult.status === "missing") {
      console.log(
        "    HOMR:         (no output — run `make homr-comparison` to generate)",
      );
    } else if (homrResult.status === "error") {
      console.log(`    HOMR:         (parse error — ${homrResult.message})`);
    } else {
      const { count, differences } = homrResult;
      if (count === 0) {
        console.log("    HOMR:         ✓ perfect (0 differences)");
      } else {
        console.log(`    HOMR:         ${count} difference(s)`);
        printDifferenceList(differences);
      }
    }

    if (ours === "skipped") {
      console.log(
        "    Our pipeline: skipped (multi-part; see SKIPPED_FIXTURES in the spec)",
      );
    } else if (homrResult.status === "ok") {
      const { count } = homrResult;
      const verdict =
        count < ours
          ? "HOMR wins"
          : count > ours
            ? "ours wins"
            : "tied";
      console.log(
        `    Our pipeline: ${ours} difference(s)  [${verdict}]`,
      );
    } else {
      console.log(`    Our pipeline: ${ours} difference(s)`);
    }
    console.log();

    summaryRows.push({
      name,
      homr:
        homrResult.status === "ok"
          ? homrResult.count
          : homrResult.status,
      ours,
    });
  }

  // Summary table
  console.log("─".repeat(50));
  console.log("Summary (differences from source score; lower is better)");
  console.log("─".repeat(50));
  const COL_W = 25;
  console.log(
    `${"fixture".padEnd(COL_W)} ${"HOMR".padStart(8)}  ${"ours".padStart(8)}`,
  );
  console.log("─".repeat(50));
  for (const { name, homr, ours } of summaryRows) {
    const homrStr = typeof homr === "number" ? String(homr) : `(${homr})`;
    const oursStr = ours === "skipped" ? "skipped" : String(ours);
    console.log(
      `${name.padEnd(COL_W)} ${homrStr.padStart(8)}  ${oursStr.padStart(8)}`,
    );
  }
}

main();
