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
}

export interface Score {
  /** Pitched notes in document order (rests carry no pitch, so they're skipped). */
  notes: Note[];
  measureCount: number;
  /** Key signature as a fifths count (0 = C major / A minor). */
  fifths: number;
  /** "N/M", "senza-misura", or "none" (no time element declared). */
  time: string;
  /** Each clef as "<sign><line>", in document order. */
  clefs: string[];
}

export function parseScore(xml: string): Score {
  const document = new DOMParser().parseFromString(xml, "text/xml");

  const notes: Note[] = [];
  for (const noteEl of Array.from(document.querySelectorAll("note"))) {
    const pitchEl = noteEl.querySelector("pitch");
    if (!pitchEl) {
      continue;
    }
    notes.push({
      step: pitchEl.querySelector("step")?.textContent ?? "?",
      alter: Number.parseInt(
        pitchEl.querySelector("alter")?.textContent ?? "0",
        10,
      ),
      octave: Number.parseInt(
        pitchEl.querySelector("octave")?.textContent ?? "0",
        10,
      ),
    });
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

export interface NoteAlignment {
  /** Same step + octave (accidental ignored). */
  matched: number;
  /** Of `matched`, how many also share the same alter. */
  accidentalMatched: number;
  /** Aligned to a note of a different pitch. */
  substitutions: number;
  /** In source, missing from recovered (a dropped note). */
  deletions: number;
  /** In recovered, absent from source (a spurious note). */
  insertions: number;
}

function samePitch(a: Note, b: Note): boolean {
  return a.step === b.step && a.octave === b.octave;
}

// Needleman–Wunsch global alignment over the two pitch streams (match +1,
// substitution/insertion/deletion −1), then a backtrace that classifies every
// column so "wrong note" (substitution), "missed note" (deletion), and "spurious
// note" (insertion) come out separately.
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
    matched: 0,
    accidentalMatched: 0,
    substitutions: 0,
    deletions: 0,
    insertions: 0,
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
      if (matched) {
        alignment.matched++;
        if (source[i - 1].alter === recovered[j - 1].alter) {
          alignment.accidentalMatched++;
        }
      } else {
        alignment.substitutions++;
      }
      i--;
      j--;
    } else if (i > 0 && (j === 0 || score[i][j] === score[i - 1][j] - 1)) {
      alignment.deletions++;
      i--;
    } else {
      alignment.insertions++;
      j--;
    }
  }
  return alignment;
}

// ── Differences ─────────────────────────────────────────────────────────────

export type Difference =
  | { kind: "key"; source: number; recovered: number }
  | { kind: "time-signature"; source: string; recovered: string }
  | { kind: "clef-count"; source: number; recovered: number }
  | { kind: "clefs"; source: string; recovered: string }
  | { kind: "measure-count"; source: number; recovered: number }
  | { kind: "missed-notes"; count: number }
  | { kind: "wrong-notes"; count: number }
  | { kind: "spurious-notes"; count: number }
  | { kind: "wrong-accidentals"; count: number };

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

  const notes = alignNotes(source.notes, recovered.notes);
  if (notes.deletions > 0) {
    differences.push({ kind: "missed-notes", count: notes.deletions });
  }
  if (notes.substitutions > 0) {
    differences.push({ kind: "wrong-notes", count: notes.substitutions });
  }
  if (notes.insertions > 0) {
    differences.push({ kind: "spurious-notes", count: notes.insertions });
  }
  const wrongAccidentals = notes.matched - notes.accidentalMatched;
  if (wrongAccidentals > 0) {
    differences.push({ kind: "wrong-accidentals", count: wrongAccidentals });
  }

  return differences;
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
    case "missed-notes":
      return `${difference.count} note(s) in the source missing from the recovery`;
    case "wrong-notes":
      return `${difference.count} note(s) recovered at the wrong pitch`;
    case "spurious-notes":
      return `${difference.count} note(s) recovered that are not in the source`;
    case "wrong-accidentals":
      return `${difference.count} recovered note(s) with the wrong accidental`;
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

// Two differences describe the same subject (so one can update the other) when
// they share a kind — every difference kind appears at most once per score.
function sameSubject(a: Difference, b: Difference): boolean {
  return a.kind === b.kind;
}

function equal(a: Difference, b: Difference): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
        "TrOMR does not emit a time signature for these staves, so the builder " +
        "falls back to 4/4. Resolving it means recovering the meter.",
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
  missedNotes(count: number): Affordance {
    return {
      id: `missed-notes ×${count}`,
      reason: "Notehead recall is below 100% on dense staves.",
      expected: { kind: "missed-notes", count },
    };
  },
  wrongNotes(count: number): Affordance {
    return {
      id: `wrong-notes ×${count}`,
      reason: "Some noteheads are recovered at the wrong pitch (staff position).",
      expected: { kind: "wrong-notes", count },
    };
  },
  spuriousNotes(count: number): Affordance {
    return {
      id: `spurious-notes ×${count}`,
      reason: "The recovery invents notes the source does not contain.",
      expected: { kind: "spurious-notes", count },
    };
  },
  wrongAccidentals(count: number): Affordance {
    return {
      id: `wrong-accidentals ×${count}`,
      reason: "Some matched notes carry the wrong accidental (TrOMR lift error).",
      expected: { kind: "wrong-accidentals", count },
    };
  },
};
