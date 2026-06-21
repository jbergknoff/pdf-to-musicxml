/**
 * Quantify how far each fixture's recovered MusicXML is from its source score.
 *
 * For every fixture under `../fixtures/` that ships a `<name>.source.musicxml`
 * (the original musicxml.com score) alongside the committed
 * `../__snapshots__/<name>.musicxml` (what the OMR pipeline recovered), this
 * reduces both to a flat, order-preserving stream of pitched notes, aligns the
 * two streams (Needleman–Wunsch), and reports recall / precision on pitch,
 * how many of the matched notes also got the right accidental, the document-level
 * attribute diffs (divisions / key / time / clef), and which notational features
 * the source carries that the OMR intentionally drops.
 *
 * The point is to make "how close are we?" a number, so we can move toward
 * asserting the recovered output *against the source* (modulo the codified
 * expected differences below) instead of against a frozen snapshot of today's
 * imperfect output.
 *
 * Run with `make compare-fixtures` (or `bun run
 * tests/integration/helpers/compare-musicxml.ts` from `lib/import-image/`).
 * Pure analysis — it reads committed files only, runs no inference, and writes
 * nothing.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DOMParser } from "linkedom";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIRECTORY = join(here, "..", "fixtures");
const SNAPSHOTS_DIRECTORY = join(here, "..", "__snapshots__");

// Source notational features the OMR pipeline does not (and is not expected to)
// reproduce. Listed so the comparison can report them as *expected* differences
// rather than counting them against the recovery. Keep this in sync with what
// the MusicXML builder actually emits (lib/assembly/musicxml-builder.ts).
const EXPECTED_DROPPED_FEATURES = [
  "lyric",
  "slur",
  "tie",
  "dynamics",
  "direction",
  "articulations",
  "ornaments",
  "stem",
  "grace",
  "tuplet",
  "fermata",
] as const;

interface Note {
  /** Diatonic step letter, e.g. "C". */
  step: string;
  /** Chromatic alteration in semitones (sharp +1, flat −1). */
  alter: number;
  octave: number;
}

interface Score {
  notes: Note[];
  measureCount: number;
  /** First declared value of each, for the attribute diff. */
  divisions: number | undefined;
  fifths: number | undefined;
  time: string | undefined;
  clefs: string[];
  /** Which EXPECTED_DROPPED_FEATURES actually occur, with counts. */
  features: Map<string, number>;
}

function parse(xml: string): Score {
  const document = new DOMParser().parseFromString(xml, "text/xml");

  const notes: Note[] = [];
  for (const noteEl of Array.from(document.querySelectorAll("note"))) {
    const pitchEl = noteEl.querySelector("pitch");
    if (!pitchEl) {
      // A rest — carries no pitch, so it can't anchor a pitch alignment.
      continue;
    }
    const step = pitchEl.querySelector("step")?.textContent ?? "?";
    const alter = Number.parseInt(
      pitchEl.querySelector("alter")?.textContent ?? "0",
      10,
    );
    const octave = Number.parseInt(
      pitchEl.querySelector("octave")?.textContent ?? "0",
      10,
    );
    notes.push({ step, alter, octave });
  }

  const firstText = (selector: string): string | undefined =>
    document.querySelector(selector)?.textContent ?? undefined;

  const beats = firstText("time beats");
  const beatType = firstText("time beat-type");
  const time =
    beats && beatType
      ? `${beats}/${beatType}`
      : document.querySelector("time senza-misura")
        ? "senza-misura"
        : undefined;

  const clefs = Array.from(document.querySelectorAll("clef")).map((clefEl) => {
    const sign = clefEl.querySelector("sign")?.textContent ?? "?";
    const line = clefEl.querySelector("line")?.textContent ?? "?";
    return `${sign}${line}`;
  });

  const divisionsText = firstText("divisions");
  const fifthsText = firstText("key fifths");

  const features = new Map<string, number>();
  for (const feature of EXPECTED_DROPPED_FEATURES) {
    const count = document.querySelectorAll(feature).length;
    if (count > 0) {
      features.set(feature, count);
    }
  }

  return {
    notes,
    measureCount: document.querySelectorAll("measure").length,
    divisions: divisionsText ? Number.parseInt(divisionsText, 10) : undefined,
    fifths: fifthsText ? Number.parseInt(fifthsText, 10) : undefined,
    time,
    clefs,
    features,
  };
}

type Op = "match" | "substitute" | "delete" | "insert";

interface Alignment {
  /** Same step + octave (accidental ignored). */
  pitchMatches: number;
  /** Of pitchMatches, how many also share the same alter. */
  accidentalMatches: number;
  /** Aligned but different pitch. */
  substitutions: number;
  /** In source, missing from recovered (a dropped note). */
  deletions: number;
  /** In recovered, absent from source (a spurious note). */
  insertions: number;
}

function samePitch(a: Note, b: Note): boolean {
  return a.step === b.step && a.octave === b.octave;
}

// Needleman–Wunsch global alignment over the two pitch streams. A pitch match
// scores +1; substitution/insertion/deletion each score −1. The backtrace
// classifies every column so we can separate "wrong note" (substitution) from
// "missed note" (deletion) and "spurious note" (insertion).
function align(source: Note[], recovered: Note[]): Alignment {
  const n = source.length;
  const m = recovered.length;
  const score: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = 0; i <= n; i++) {
    score[i][0] = -i;
  }
  for (let j = 0; j <= m; j++) {
    score[0][j] = -j;
  }
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const diagonal =
        score[i - 1][j - 1] + (samePitch(source[i - 1], recovered[j - 1]) ? 1 : -1);
      score[i][j] = Math.max(diagonal, score[i - 1][j] - 1, score[i][j - 1] - 1);
    }
  }

  const result: Alignment = {
    pitchMatches: 0,
    accidentalMatches: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
  };
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    let op: Op;
    if (i > 0 && j > 0) {
      const matched = samePitch(source[i - 1], recovered[j - 1]);
      const diagonal = score[i - 1][j - 1] + (matched ? 1 : -1);
      if (score[i][j] === diagonal) {
        op = matched ? "match" : "substitute";
      } else if (score[i][j] === score[i - 1][j] - 1) {
        op = "delete";
      } else {
        op = "insert";
      }
    } else if (i > 0) {
      op = "delete";
    } else {
      op = "insert";
    }

    if (op === "match") {
      result.pitchMatches++;
      if (source[i - 1].alter === recovered[j - 1].alter) {
        result.accidentalMatches++;
      }
      i--;
      j--;
    } else if (op === "substitute") {
      result.substitutions++;
      i--;
      j--;
    } else if (op === "delete") {
      result.deletions++;
      i--;
    } else {
      result.insertions++;
      j--;
    }
  }
  return result;
}

function percent(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "n/a";
  }
  return `${((100 * numerator) / denominator).toFixed(1)}%`;
}

function fixtureNames(): string[] {
  return readdirSync(FIXTURES_DIRECTORY)
    .filter((name) => name.endsWith(".source.musicxml"))
    .map((name) => name.slice(0, -".source.musicxml".length))
    .sort();
}

function compare(name: string): void {
  const source = parse(
    readFileSync(join(FIXTURES_DIRECTORY, `${name}.source.musicxml`), "utf8"),
  );
  const recovered = parse(
    readFileSync(join(SNAPSHOTS_DIRECTORY, `${name}.musicxml`), "utf8"),
  );
  const alignment = align(source.notes, recovered.notes);

  console.log(`\n══ ${name} ══`);
  console.log(
    `  notes      source ${source.notes.length}  recovered ${recovered.notes.length}`,
  );
  console.log(
    `  measures   source ${source.measureCount}  recovered ${recovered.measureCount}`,
  );
  console.log(
    `  pitch      recall ${percent(alignment.pitchMatches, source.notes.length)} ` +
      `(${alignment.pitchMatches}/${source.notes.length})  ` +
      `precision ${percent(alignment.pitchMatches, recovered.notes.length)} ` +
      `(${alignment.pitchMatches}/${recovered.notes.length})`,
  );
  console.log(
    `  errors     ${alignment.substitutions} wrong-pitch  ` +
      `${alignment.deletions} missed  ${alignment.insertions} spurious`,
  );
  console.log(
    `  accidental ${percent(alignment.accidentalMatches, alignment.pitchMatches)} ` +
      `of matched notes correct (${alignment.accidentalMatches}/${alignment.pitchMatches})`,
  );

  const attribute = (
    label: string,
    a: string | number | undefined,
    b: string | number | undefined,
  ): string => {
    const agree = String(a) === String(b) ? "✓" : "✗";
    return `${agree} ${label} source ${a ?? "—"} / recovered ${b ?? "—"}`;
  };
  console.log("  attributes");
  console.log(`    ${attribute("divisions", source.divisions, recovered.divisions)}`);
  console.log(`    ${attribute("key (fifths)", source.fifths, recovered.fifths)}`);
  console.log(`    ${attribute("time", source.time, recovered.time)}`);
  console.log(
    `    ${attribute("clefs", source.clefs.join(",") || "—", recovered.clefs.join(",") || "—")}`,
  );

  const dropped = [...source.features.entries()]
    .map(([feature, count]) => `${feature}×${count}`)
    .join(", ");
  console.log(`  dropped    ${dropped || "(none in source)"}`);
}

function main(): void {
  console.log(
    "Source-vs-recovered MusicXML comparison.\n" +
      "Pitch alignment ignores accidentals (reported separately). Dropped =\n" +
      "source features the OMR is not expected to reproduce.",
  );
  for (const name of fixtureNames()) {
    compare(name);
  }
}

main();
