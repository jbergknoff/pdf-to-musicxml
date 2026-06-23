/**
 * Diff a fixture's *recovered* MusicXML (what the OMR pipeline produced) against
 * its *source* score (the original musicxml.com file), and check that every
 * difference is one we have explicitly codified as a known, currently-expected
 * "affordance".
 *
 * The integration test uses this instead of asserting the recovered MusicXML
 * against a frozen snapshot. The point is a two-way ratchet:
 *
 *   • an *uncodified* difference fails the test — a regression, or a real
 *     difference nobody has accounted for; and
 *   • an affordance that no longer corresponds to an actual difference *also*
 *     fails the test — the OMR improved past it, so the affordance must be
 *     deleted (or tightened). That is how improving the OMR is supposed to feel:
 *     you make it better, a now-unnecessary affordance trips, you remove it, and
 *     the bar is permanently higher.
 *
 * What is compared: the ordered stream of pitched notes (step + octave, with
 * accidentals checked separately) and the document attributes (key, time, clefs,
 * measure count). What is deliberately NOT compared — these are permanent
 * properties of the pipeline, not deficiencies to ratchet, so they are stripped
 * rather than codified per fixture:
 *   • notational features the builder never emits (NEVER_COMPARED_FEATURES);
 *   • raw <duration> values (the builder normalizes <divisions>, so durations
 *     are not commensurable — only note identity and order are compared); and
 *   • layout / identification / print metadata.
 *
 * Runtime-agnostic apart from linkedom's DOMParser (Node has no global one),
 * which both the integration test (Playwright/Node) and any script can use.
 */
import { DOMParser } from "linkedom";

// Source notational features the OMR does not target and is not expected to
// reproduce. Listed here so "we don't compare these" is explicit and in one
// place; they are never read out of either document, so they never surface as a
// difference. (Recovering them would be a feature, not a ratchet.)
export const NEVER_COMPARED_FEATURES = [
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

export interface Note {
  /** Diatonic step letter, e.g. "C". */
  step: string;
  /** Chromatic alteration in semitones (sharp +1, flat −1). */
  alter: number;
  octave: number;
  /** The (printed) measure number this note belongs to, so a difference can
   * say *where* a note was missed/wrong, not just how many. */
  measure: number;
}

/** Render a note as a compact pitch token, e.g. {C,+1,5} → "C#5", {B,−1,4} → "Bb4". */
export function formatPitch(note: Note): string {
  const accidental =
    note.alter > 0
      ? "#".repeat(note.alter)
      : note.alter < 0
        ? "b".repeat(-note.alter)
        : "";
  return `${note.step}${accidental}${note.octave}`;
}

export interface Score {
  /** Pitched notes, canonicalized per measure (see {@link parseScore}). */
  notes: Note[];
  measureCount: number;
  /** Key signature as a fifths count (0 = C major / A minor). */
  fifths: number;
  /** "N/M", "senza-misura", or "none" (no time element declared). */
  time: string;
  /** Each clef as "<sign><line>", in document order. */
  clefs: string[];
}

// Semitone offset of each diatonic step within an octave, for ordering
// simultaneous notes by pitch (a chord/voice stack is unordered, so we need a
// stable canonical order — see parseScore).
const STEP_SEMITONE: Readonly<Record<string, number>> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

function pitchChroma(step: string, alter: number, octave: number): number {
  return octave * 12 + (STEP_SEMITONE[step] ?? 0) + alter;
}

/**
 * Read a score into the comparable form: its pitched notes (canonicalized, see
 * below), measure count, key, time, and clefs.
 *
 * **Per-measure canonicalization.** A chord — and, more generally, any set of
 * notes sounding at the same instant (multiple voices in a staff, both hands of
 * a grand staff) — is an *unordered* set of pitches; the order they happen to
 * appear in the document is not musically meaningful, and TrOMR emits a chord's
 * members in a different order than the engraver wrote them. Comparing the raw
 * document order therefore reports spurious "wrong notes" whenever two scores
 * stack the same pitches differently. To avoid that we group each measure's
 * notes by **onset** and sort each onset group by pitch, so simultaneous notes
 * compare as a set while the *sequence* of distinct onsets (the melody) is
 * preserved exactly. Onset is the MusicXML time cursor: a non-chord note
 * advances it by its duration, a `<chord/>` member and a grace note do not, and
 * `<backup>`/`<forward>` move it (this is how a score interleaves voices/hands).
 * Monophonic music has one note per onset, so its order is untouched.
 */
export function parseScore(xml: string): Score {
  const document = new DOMParser().parseFromString(xml, "text/xml");

  // Walk measures (not all notes at once) so each note carries its measure
  // number — the source's printed number when present, else its ordinal.
  const notes: Note[] = [];
  const measureEls = Array.from(document.querySelectorAll("measure"));
  for (let index = 0; index < measureEls.length; index++) {
    const measureEl = measureEls[index];
    const measure = Number.parseInt(
      measureEl.getAttribute("number") ?? `${index + 1}`,
      10,
    );

    // Simulate the time cursor through the measure's children, tagging each
    // pitched note with its onset, then sort by (onset, pitch) — see the doc note.
    const measureNotes: { note: Note; onset: number; chroma: number }[] = [];
    let cursor = 0;
    let lastOnset = 0;
    for (const child of Array.from(measureEl.children)) {
      const tag = child.tagName?.toLowerCase();
      const durationOf = () =>
        Number.parseInt(child.querySelector("duration")?.textContent ?? "0", 10);
      if (tag === "backup") {
        cursor -= durationOf();
        continue;
      }
      if (tag === "forward") {
        cursor += durationOf();
        continue;
      }
      if (tag !== "note") {
        continue;
      }
      const isChord = child.querySelector("chord") !== null;
      const isGrace = child.querySelector("grace") !== null;
      const onset = isChord ? lastOnset : cursor;
      if (!isChord) {
        lastOnset = cursor;
      }
      const pitchEl = child.querySelector("pitch");
      if (pitchEl) {
        const step = pitchEl.querySelector("step")?.textContent ?? "?";
        const alter = Number.parseInt(
          pitchEl.querySelector("alter")?.textContent ?? "0",
          10,
        );
        const octave = Number.parseInt(
          pitchEl.querySelector("octave")?.textContent ?? "0",
          10,
        );
        measureNotes.push({
          note: { step, alter, octave, measure },
          onset,
          chroma: pitchChroma(step, alter, octave),
        });
      }
      // A chord member shares the previous onset and a grace note borrows time;
      // neither advances the cursor.
      if (!isChord && !isGrace) {
        cursor += durationOf();
      }
    }

    measureNotes.sort((a, b) => a.onset - b.onset || a.chroma - b.chroma);
    for (const measureNote of measureNotes) {
      notes.push(measureNote.note);
    }
  }

  const beats = document.querySelector("time beats")?.textContent;
  const beatType = document.querySelector("time beat-type")?.textContent;
  const time = beats && beatType
    ? `${beats}/${beatType}`
    : document.querySelector("time senza-misura")
      ? "senza-misura"
      : "none";

  const clefs = Array.from(document.querySelectorAll("clef")).map((clefEl) => {
    const sign = clefEl.querySelector("sign")?.textContent ?? "?";
    const line = clefEl.querySelector("line")?.textContent ?? "?";
    return `${sign}${line}`;
  });

  return {
    notes,
    measureCount: document.querySelectorAll("measure").length,
    fifths: Number.parseInt(
      document.querySelector("key fifths")?.textContent ?? "0",
      10,
    ),
    time,
    clefs,
  };
}

// ── Pitch alignment ────────────────────────────────────────────────────────

/** A source note aligned to a recovered note of the same step + octave. */
export interface NotePair {
  source: Note;
  recovered: Note;
}

export interface NoteAlignment {
  /** Aligned to a recovered note of the same step + octave (accidental may still differ). */
  matched: NotePair[];
  /** Aligned to a recovered note of a different pitch (a wrong note). */
  substitutions: NotePair[];
  /** In source, missing from recovered (a dropped note). */
  deletions: Note[];
  /** In recovered, absent from source (a spurious note). */
  insertions: Note[];
}

function samePitch(a: Note, b: Note): boolean {
  return a.step === b.step && a.octave === b.octave;
}

// Needleman–Wunsch global alignment over the two pitch streams (match +1,
// substitution/insertion/deletion −1), then a backtrace that classifies every
// column so "wrong note" (substitution), "missed note" (deletion), and "spurious
// note" (insertion) come out separately — each carrying the actual notes so we
// can report *which* note, and in which measure, not just a count.
export function alignNotes(source: Note[], recovered: Note[]): NoteAlignment {
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
        score[i - 1][j - 1] +
        (samePitch(source[i - 1], recovered[j - 1]) ? 1 : -1);
      score[i][j] = Math.max(diagonal, score[i - 1][j] - 1, score[i][j - 1] - 1);
    }
  }

  const alignment: NoteAlignment = {
    matched: [],
    substitutions: [],
    deletions: [],
    insertions: [],
  };
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const matched =
      i > 0 && j > 0 && samePitch(source[i - 1], recovered[j - 1]);
    const diagonal =
      i > 0 && j > 0
        ? score[i - 1][j - 1] + (matched ? 1 : -1)
        : Number.NEGATIVE_INFINITY;
    if (i > 0 && j > 0 && score[i][j] === diagonal) {
      const pair = { source: source[i - 1], recovered: recovered[j - 1] };
      if (matched) {
        alignment.matched.push(pair);
      } else {
        alignment.substitutions.push(pair);
      }
      i--;
      j--;
    } else if (i > 0 && (j === 0 || score[i][j] === score[i - 1][j] - 1)) {
      alignment.deletions.push(source[i - 1]);
      i--;
    } else {
      alignment.insertions.push(recovered[j - 1]);
      j--;
    }
  }
  return alignment;
}

// ── Differences ─────────────────────────────────────────────────────────────

// Attribute-level differences are singletons per score (each kind appears at
// most once); note-level differences are per-note and carry the pitch + measure
// so each one names *which* note, in *which* measure, differs.
export type Difference =
  | { kind: "key"; source: number; recovered: number }
  | { kind: "time-signature"; source: string; recovered: string }
  | { kind: "clef-count"; source: number; recovered: number }
  | { kind: "clefs"; source: string; recovered: string }
  | { kind: "measure-count"; source: number; recovered: number }
  | { kind: "missed-note"; measure: number; pitch: string }
  | { kind: "wrong-note"; measure: number; source: string; recovered: string }
  | { kind: "spurious-note"; measure: number; pitch: string }
  | {
      kind: "wrong-accidental";
      measure: number;
      source: string;
      recovered: string;
    };

const ATTRIBUTE_KINDS = new Set<Difference["kind"]>([
  "key",
  "time-signature",
  "clef-count",
  "clefs",
  "measure-count",
]);

// Deterministic order for the per-note differences so the codified list is
// stable: by measure, then by the pitch string(s) involved.
function noteSortKey(difference: Difference): string {
  switch (difference.kind) {
    case "missed-note":
    case "spurious-note":
      return `${String(difference.measure).padStart(4, "0")}|${difference.pitch}`;
    case "wrong-note":
    case "wrong-accidental":
      return `${String(difference.measure).padStart(4, "0")}|${difference.source}|${difference.recovered}`;
    default:
      return "";
  }
}

/** Every way the recovered score currently differs from the source. */
export function computeDifferences(
  source: Score,
  recovered: Score,
): Difference[] {
  const differences: Difference[] = [];

  if (source.fifths !== recovered.fifths) {
    differences.push({
      kind: "key",
      source: source.fifths,
      recovered: recovered.fifths,
    });
  }
  if (source.time !== recovered.time) {
    differences.push({
      kind: "time-signature",
      source: source.time,
      recovered: recovered.time,
    });
  }
  if (source.clefs.length !== recovered.clefs.length) {
    differences.push({
      kind: "clef-count",
      source: source.clefs.length,
      recovered: recovered.clefs.length,
    });
  } else if (source.clefs.join(",") !== recovered.clefs.join(",")) {
    differences.push({
      kind: "clefs",
      source: source.clefs.join(","),
      recovered: recovered.clefs.join(","),
    });
  }
  if (source.measureCount !== recovered.measureCount) {
    differences.push({
      kind: "measure-count",
      source: source.measureCount,
      recovered: recovered.measureCount,
    });
  }

  const alignment = alignNotes(source.notes, recovered.notes);
  const noteDifferences: Difference[] = [];
  for (const note of alignment.deletions) {
    noteDifferences.push({
      kind: "missed-note",
      measure: note.measure,
      pitch: formatPitch(note),
    });
  }
  for (const { source: from, recovered: to } of alignment.substitutions) {
    noteDifferences.push({
      kind: "wrong-note",
      measure: from.measure,
      source: formatPitch(from),
      recovered: formatPitch(to),
    });
  }
  for (const note of alignment.insertions) {
    noteDifferences.push({
      kind: "spurious-note",
      measure: note.measure,
      pitch: formatPitch(note),
    });
  }
  for (const { source: from, recovered: to } of alignment.matched) {
    if (from.alter !== to.alter) {
      noteDifferences.push({
        kind: "wrong-accidental",
        measure: from.measure,
        source: formatPitch(from),
        recovered: formatPitch(to),
      });
    }
  }
  noteDifferences.sort((a, b) => noteSortKey(a).localeCompare(noteSortKey(b)));

  return [...differences, ...noteDifferences];
}

function describe(difference: Difference): string {
  switch (difference.kind) {
    case "key":
      return `key: source fifths ${difference.source}, recovered ${difference.recovered}`;
    case "time-signature":
      return `time signature: source ${difference.source}, recovered ${difference.recovered}`;
    case "clef-count":
      return `clef count: source ${difference.source}, recovered ${difference.recovered}`;
    case "clefs":
      return `clefs: source ${difference.source}, recovered ${difference.recovered}`;
    case "measure-count":
      return `measure count: source ${difference.source}, recovered ${difference.recovered}`;
    case "missed-note":
      return `missed ${difference.pitch} (source m${difference.measure})`;
    case "wrong-note":
      return `wrong note: recovered ${difference.recovered} where source has ${difference.source} (m${difference.measure})`;
    case "spurious-note":
      return `spurious ${difference.pitch} (m${difference.measure})`;
    case "wrong-accidental":
      return `wrong accidental: recovered ${difference.recovered} where source has ${difference.source} (m${difference.measure})`;
  }
}

// ── Affordances ───────────────────────────────────────────────────────────────

/**
 * A single codified, currently-expected difference. `expected` is the exact
 * difference we tolerate today; `reason` explains why it exists and what
 * resolving it would take, so a failure message is self-documenting.
 */
export interface Affordance {
  id: string;
  reason: string;
  expected: Difference;
}

function equal(a: Difference, b: Difference): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Two differences describe the same subject — so an affordance for one can
// report the other as a "stale" update rather than as separate obsolete +
// uncodified problems. Attribute-level differences are singletons per score, so
// sharing a kind is enough. Note-level differences are per-note, so the subject
// is the whole note (pitch + measure): a missed note that moved or changed pitch
// is a *different* subject (the old affordance is obsolete, the new one
// uncodified), which is the clearer report.
function sameSubject(a: Difference, b: Difference): boolean {
  if (a.kind !== b.kind) {
    return false;
  }
  if (ATTRIBUTE_KINDS.has(a.kind)) {
    return true;
  }
  return equal(a, b);
}

/**
 * Assert that the recovered score differs from the source in exactly the ways
 * `affordances` codifies — no more (a regression / uncodified difference) and no
 * fewer (an affordance the OMR has outgrown). Throws one Error listing every
 * problem, with guidance, on any mismatch.
 */
export function assertDifferencesCodified(
  source: Score,
  recovered: Score,
  affordances: Affordance[],
): void {
  const remaining = computeDifferences(source, recovered);
  const problems: string[] = [];

  for (const affordance of affordances) {
    const index = remaining.findIndex((difference) =>
      sameSubject(difference, affordance.expected),
    );
    if (index === -1) {
      problems.push(
        `Affordance "${affordance.id}" is no longer necessary: the recovered ` +
          `output no longer differs from the source as [${describe(affordance.expected)}]. ` +
          `The OMR improved here — delete this affordance to lock in the gain. ` +
          `(was tolerated because: ${affordance.reason})`,
      );
      continue;
    }
    const actual = remaining[index];
    remaining.splice(index, 1);
    if (!equal(actual, affordance.expected)) {
      problems.push(
        `Affordance "${affordance.id}" is stale: it codifies ` +
          `[${describe(affordance.expected)}] but the recovery now shows ` +
          `[${describe(actual)}]. Update the affordance to the new value ` +
          `(ratchet) — or, if it got worse, investigate a regression. ` +
          `(${affordance.reason})`,
      );
    }
  }

  for (const difference of remaining) {
    problems.push(
      `Uncodified difference between source and recovered MusicXML: ` +
        `[${describe(difference)}]. Fix the OMR, or add an affordance for this ` +
        `fixture to EXPECTED_DIFFERENCES (in import-image.spec.ts) explaining ` +
        `why this difference is currently expected.`,
    );
  }

  if (problems.length > 0) {
    throw new Error(
      `Recovered MusicXML differs from the source in ways that don't match the ` +
        `codified affordances:\n${problems.map((p) => `  • ${p}`).join("\n")}`,
    );
  }
}

// Readable builders for the per-fixture affordance lists. Each carries the
// standing reason the difference exists today.
export const codify = {
  timeSignature(source: string, recovered: string): Affordance {
    return {
      id: `time-signature ${source}→${recovered}`,
      reason:
        "TrOMR emits no time-signature token for these staves; the builder " +
        "infers the meter from the recovered rhythms (lib/assembly/meter.ts), " +
        "which recovers the measure length but not simple-vs-compound (6/8 reads " +
        "as 3/4) and needs >1 measure (an unmetered single measure keeps 4/4).",
      expected: { kind: "time-signature", source, recovered },
    };
  },
  key(source: number, recovered: number): Affordance {
    return {
      id: `key ${source}→${recovered}`,
      reason: "The recovered key signature differs from the source.",
      expected: { kind: "key", source, recovered },
    };
  },
  clefCount(source: number, recovered: number): Affordance {
    return {
      id: `clef-count ${source}→${recovered}`,
      reason:
        "Some staves/systems were not detected, so fewer clefs are recovered " +
        "than the source declares.",
      expected: { kind: "clef-count", source, recovered },
    };
  },
  measureCount(source: number, recovered: number): Affordance {
    return {
      id: `measure-count ${source}→${recovered}`,
      reason:
        "The recovery has the wrong number of measures (dropped staves/systems " +
        "or mis-segmented barlines).",
      expected: { kind: "measure-count", source, recovered },
    };
  },
  /** A source note the OMR failed to find. `pitch` like "C5"/"Bb4". */
  missedNote(measure: number, pitch: string): Affordance {
    return {
      id: `missed ${pitch} (m${measure})`,
      reason:
        "Notehead recall is below 100% on dense staves — this source note was " +
        "not found.",
      expected: { kind: "missed-note", measure, pitch },
    };
  },
  /** A source note recovered at the wrong pitch (staff position). */
  wrongNote(measure: number, source: string, recovered: string): Affordance {
    return {
      id: `wrong note m${measure} ${source}→${recovered}`,
      reason:
        "This source note was recovered at the wrong pitch (wrong staff " +
        "position).",
      expected: { kind: "wrong-note", measure, source, recovered },
    };
  },
  /** A note the recovery invented; the source has nothing matching it. */
  spuriousNote(measure: number, pitch: string): Affordance {
    return {
      id: `spurious ${pitch} (m${measure})`,
      reason: "The recovery invents this note; the source has nothing here.",
      expected: { kind: "spurious-note", measure, pitch },
    };
  },
  /** A matched note (right step + octave) carrying the wrong accidental. */
  wrongAccidental(
    measure: number,
    source: string,
    recovered: string,
  ): Affordance {
    return {
      id: `wrong accidental m${measure} ${source}→${recovered}`,
      reason: "Matched note carries the wrong accidental (TrOMR lift error).",
      expected: { kind: "wrong-accidental", measure, source, recovered },
    };
  },
};
