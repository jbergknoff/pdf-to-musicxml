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
| `mozart-piano-sonata` | 1 grace-acc + 2 low-bass misreads (meter `2/4` recovered; grace notes emitted; chords compared as sets) |
| `binchois` (skipped)  | 34→23 measures; 4→2 clefs; 58 missed, 20 wrong, 29 spurious, 3 acc. — *stale*, see below |

Read this as: `chant` and `saltarello` recover **every pitch and attribute except
the meter**. The dense scores additionally drop and mis-place notes.

`binchois`'s row is the **old two-staff recovery** and will be rewritten when the
fixture is unskipped: staff detection now recovers all four staves (see fix 2),
so the `4→2 clefs` and inflated measure/note counts no longer reflect the
pipeline — they are kept only as a placeholder until system grouping is fixed and
real numbers can be measured.

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

## Findings so far

Four affordance classes have already been retired by recent work:

- **Grace notes are now recovered, not dropped.** TrOMR tags the dense low-bass
  arpeggios in `mozart` (e.g. m98's A2/C#3/E3) as *grace* notes (`note_32G`), and
  the decoder used to drop every grace token — losing ~15 real pitches. A grace
  note is still a pitched note, and the diff reads every pitched note from the
  source (graces included), so dropping them only cost recall. `decode-tokens.ts`
  now emits them as proper **zero-duration `<grace/>` notes** (excluded from
  measure length, meter inference, and beam beats — see `meter.ts`/`beams.ts`/the
  builder), so their pitch is recovered without adding measure time. That retired
  **every** `mozart` missed-note affordance (19→0) and left the inferred meter at
  2/4.

- **Chords/voices are compared as unordered sets.** A chord — or any notes
  sounding at one instant (multiple voices in a staff, both hands of a grand
  staff) — is an unordered pitch set, but the diff used to align the flat
  document-order stream sequentially, so a chord whose members TrOMR emitted in a
  different order than the engraver read as paired "wrong notes". `parseScore`
  (`musicxml-diff.ts`) now tags each note with its **onset** (simulating the
  MusicXML time cursor: non-chord notes advance it, `<chord/>`/grace notes do
  not, `<backup>`/`<forward>` move it) and sorts each measure by `(onset, pitch)`,
  so simultaneous notes compare as a set while the melodic sequence of distinct
  onsets is preserved (monophonic music is untouched — one note per onset). That
  removed ~14 of `mozart`'s "wrong notes" (e.g. m101 `[E5,A5,C#6]` vs
  `[C#6,A5,E5]`), leaving only **3 genuine** differences: a lift error on the m98
  bass grace (A2→A#2) and two low-bass grace misreads (m100 D2→C#2, F#2→E2).

- **Meter is now inferred, not guessed.** `buildScore` derives the time signature
  from the recovered rhythms (`lib/assembly/meter.ts`) instead of defaulting to
  4/4. This made `mozart` (2/4) exact — its time affordance is gone — and gives
  `saltarello` the correct *measure length* (it now reads 3/4; only the
  simple-vs-compound distinction, which needs a beaming signal TrOMR does not
  emit, keeps a residual affordance). `chant`'s single unmetered measure is too
  short to infer from, so it keeps the 4/4 default.
- **Staff detection on dense engravings is fixed.** The model-free classical
  staff path was unreliable on `binchois` (recovering only two of four staves),
  so the pipeline now falls back to the oemer UNet when the classical mask looks
  unreliable (`staffDetectionLooksReliable`). All four `binchois` staves are now
  recovered.

## The highest-value fixes next (which affordances to retire first)

1. **Low-bass grace recall/spelling on `mozart` (the genuine residual).** All
   that is left on `mozart` are 3 real model errors, every one in the tightly
   packed low-bass grace arpeggios: a lift error (m98 A2→A#2) and two pitch
   misreads (m100 D2→C#2, F#2→E2). These are TrOMR notehead/accidental limits at
   the bottom of the bass staff, not assembler or diff issues — closing them needs
   a stronger transcription pass (or a higher-resolution crop) on that region.

2. **`binchois` system grouping (the unskip blocker).** Staff detection now
   recovers all four staves (fix above), so the remaining blockers before
   `binchois` can leave `SKIPPED_FIXTURES` are: (a) its two-system × two-staff
   layout is mis-paired by `groupSystems` — the four staves need to group as
   *two systems of two* (treble/bass each), and getting that wrong is what
   inflates the measure count and over-fills measures; and (b) the note errors
   from fix 1. The recovery path is: fix grouping → run the suite to get the
   real four-staff diff → rewrite `binchois`'s `EXPECTED_DIFFERENCES` from the
   placeholder list to the measured one → remove it from `SKIPPED_FIXTURES`.

3. **Simple-vs-compound meter (`saltarello`).** Closing the last `6/8`→`3/4`
   affordance needs a beat-grouping/beaming signal. TrOMR emits no beam tokens,
   so this is a genuine model-input gap, not a builder fix — lowest priority of
   the three, and tracked here so the affordance isn't mistaken for a bug.
