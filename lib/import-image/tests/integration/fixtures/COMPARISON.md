# Source-vs-recovered MusicXML: the diff/affordance model

The OMR integration tests assert the recovered MusicXML **against each fixture's
source score** (`<name>.source.musicxml`), not against a frozen snapshot of
today's imperfect output. The recovered MusicXML is no longer committed at all.

Each fixture declares, in the spec's `EXPECTED_DIFFERENCES`, the *specific*
ways its recovery currently differs from the real score — its **affordances**.
The test (`../helpers/musicxml-diff.ts`) computes the actual diff and asserts it
matches that list **exactly**, which ratchets in both directions:

- an **uncodified** difference fails the test — a regression, or a real
  difference nobody accounted for; and
- an affordance that **no longer matches** an actual difference *also* fails —
  the OMR improved past it, so the affordance must be deleted (or updated).
  Improving the OMR is meant to feel like: make it better → a now-unnecessary
  affordance trips → delete it → the bar is permanently higher.

## What is compared

The ordered stream of pitched notes (step + octave, accidentals checked
separately) and the document attributes: key, time signature, clefs, measure
count. Notes are aligned with Needleman–Wunsch so "wrong pitch", "missed", and
"spurious" come out separately.

Each note-level affordance names the **specific note and its measure**, not just
a count — `codify.missedNote(98, "A2")` (a source A2 in measure 98 the OMR never
found), `codify.wrongNote(100, "A2", "F#5")` (source A2 read as F#5),
`codify.spuriousNote(1, "A6")`, `codify.wrongAccidental(13, "Bb3", "B3")`.
Measures are the source's measure numbers, so a failure points at exactly which
note in which bar regressed (or improved past its affordance). The per-fixture
totals in the table below are just the lengths of those per-note lists.

## What is deliberately not compared (stripped, not ratcheted)

These are permanent properties of the pipeline, not deficiencies, so the diff
ignores them rather than asking each fixture to codify them:

- **Notational features the builder never emits** — `lyric`, `slur`, `tie`,
  `direction`, `dynamics`, `articulations`, `ornaments`, `stem`, `grace`,
  `tuplet`, `fermata` (`NEVER_COMPARED_FEATURES` in `musicxml-diff.ts`).
- **Raw `<duration>` values** — the builder normalizes `<divisions>` (e.g. 8→4),
  so durations aren't commensurable; only note identity and order are compared.
  (Rhythm/type comparison is a possible future addition.)
- **Layout / identification / print metadata.**

## Current affordances (what the gap is today)

| fixture               | codified affordances                                                                 |
| --------------------- | ------------------------------------------------------------------------------------ |
| `chant`               | time signature `senza-misura`→`4/4`                                                   |
| `saltarello`          | time signature `6/8`→`3/4`                                                            |
| `mozart-piano-sonata` | 19 missed, 11 wrong-pitch, 2 spurious, 1 wrong-accidental                             |
| `binchois` (skipped)  | 34→23 measures; 4→2 clefs; 58 missed, 20 wrong, 29 spurious, 3 acc.                   |

Read this as: `chant` and `saltarello` recover **every pitch and attribute except
the meter**. The dense scores additionally drop and mis-place notes.

## Meter inference

TrOMR emits no time-signature token for any of these fixtures, so the builder
**infers the meter from the recovered rhythms** (`lib/assembly/meter.ts`): the
most common per-measure total duration is the measure length, mapped to a simple
(quarter-beat) meter. This made `mozart` (2/4) exact — its time affordance is
retired — and gives `saltarello` the right measure length. It does **not**
recover simple-vs-compound (a 6/8 measure has the same length as 3/4, and beaming
is not in TrOMR's tokens), so `saltarello` is inferred as `3/4`; closing that last
gap needs a beaming/beat-grouping signal. `chant` is a single unmetered measure —
too little to infer from — so it keeps the `4/4` default.

## The highest-value fixes (which affordances to retire first)

1. **Notehead recall on dense staves** (`mozart`, `binchois` missed-notes).
   Accidentals, once a note is found, are essentially correct (the
   wrong-accidental counts are tiny), so the weakness is *finding and placing*
   notes, not spelling them.
2. **Staff/system detection** (`binchois` clef-count and measure-count): only two
   of its four bass-clef staves survive, which is also why it over-fills a measure
   and can't be engraved — hence it is in `SKIPPED_FIXTURES`.
