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
| `binchois` (skipped)  | key `-1` + meter `3/4` now recovered; 34→23 measures; 4→2 clefs; 59 missed, 0 wrong, 30 spurious, 3 acc. (measured; **mostly diff artifacts**, see below) |

Read this as: `chant` and `saltarello` recover **every pitch and attribute except
the meter**. The dense scores additionally drop and mis-place notes.

`binchois`'s row was rewritten from a stale two-staff placeholder to the **measured
four-staff recovery** (run the pipeline over the fixture and diff it; the numbers
are deterministic). Two things improved and are no longer a gap: the **key
signature** (`-1`, one flat) and the **meter** (`3/4`, via rhythm inference) now
come out right. But the note-level counts are **misleading**, and the fixture
stays skipped, because `binchois` is a **two-part vocal score** (Cantus + "Cantus 2
and Tenor") that the single-part pipeline flattens:

- **`4→2 clefs` and `34→23 measures` are structural, not recognition gaps.** The
  source is `score-partwise` with two `<part>`s, so it declares four clefs (two per
  part) and 34 `<measure>` elements (17 per part). The pipeline assembles one part,
  so it emits two clefs and 23 continuously-numbered measures. No amount of better
  recognition closes this without **emitting two parts**.
- **The 59 missed / 30 spurious notes are largely alignment artifacts.** The diff
  compares one flat, document-order note stream. The source's is `P1`-then-`P2`
  (each part's two systems concatenated); the recovery's interleaves the staves of
  each system and runs system-by-system — a *different order* over largely the
  *same pitches*, which Needleman–Wunsch charges as paired deletions+insertions.
  131 of the source's 160 notes are recovered; the "missed/spurious" split mostly
  reflects re-ordering, not true misses. A part-aware diff (or multi-part assembly)
  would collapse most of these.

So unskipping `binchois` needs **multi-part assembly** (or a part-aware diff), not
the system-grouping tweak the next-fixes list previously implied — see fix 2.

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
  recovered. (The classical path's reliability check fires here, so `binchois`
  goes through the UNet; the other three fixtures stay on the classical path.)

## The highest-value fixes next (which affordances to retire first)

1. **Low-bass grace recall/spelling on `mozart` (the genuine residual).** All
   that is left on `mozart` are 3 real model errors, every one in the tightly
   packed low-bass grace arpeggios: a lift error (m98 A2→A#2) and two pitch
   misreads (m100 D2→C#2, F#2→E2). These are TrOMR notehead/accidental limits at
   the bottom of the bass staff, not assembler or diff issues.

   **The "higher-resolution crop" idea was tested and ruled out.** mozart's bass
   staff is one wide grand-staff strip (~4500 px), so the TrOMR canvas scales it
   to fit width 1280 — squeezing the staff to ~48 px tall in the 256-tall canvas
   (interline ~12 px) and leaving most of the vertical resolution unused. The
   obvious fix is to split a wide staff into narrower horizontal slices so each
   slice fills more of the canvas. Transcribing the bass staff in half-width
   slices (interline ~22 px, ~2× the vertical resolution) does **not** fix the
   misreads: the m100 arpeggio still decodes `C#2 E2 A2`, byte-identical to the
   full-width read, and the m98 arpeggio gets *worse* (`G#2 B2 E3`). Splitting
   also re-centers each slice, which shifts the absolute vertical reference the
   model reads pitch from and throws the read off by an octave on other slices.
   So the remaining errors are the model reading these specific densely-packed
   low ledger noteheads/accidentals wrong, independent of resolution — closing
   them needs a stronger transcription model (or a model fine-tuned on dense
   bass-clef grace passages), not a crop/tiling change in our pipeline.

2. **`binchois` multi-part assembly (the unskip blocker).** This was previously
   filed as a system-grouping fix, but measuring the real four-staff recovery
   shows grouping is *not* the gate. `binchois` is a **two-part vocal score**
   (Cantus + "Cantus 2 and Tenor"), laid out as two systems of two staves each;
   the single-part pipeline flattens it, which is what produces the structural
   `4→2 clefs` / `34→23 measures` differences and scrambles the note order the
   flat diff aligns on (so its 59 missed / 30 spurious are mostly alignment
   artifacts, not recognition gaps — see the affordances table). The real path to
   unskip is to **emit two `<part>`s** (and have the diff compare part-by-part),
   not to re-pair systems. Two sub-points worth recording for whoever does it:
   - The four staves are **evenly spaced** (every inter-staff gap is ≈11 unit
     sizes), so vertical-gap geometry cannot tell a within-system gap from a
     between-system one. And there is **no brace ink** bridging the first
     system's two staves (the second system's *is* detected), so brace links come
     out `[false, false, true]` and `groupSystems` mis-pairs to `[s0],[s1],[s2,s3]`.
     Neither geometry nor braces disambiguate this layout; part assignment has to
     come from elsewhere (e.g. a fixed staves-per-system count once part count is
     known).
   - Staff detection also mis-measures the second staff's left extent (it starts
     at `left≈227` while the others start at `left≈0`), which is the proximate
     reason the first system's brace scan lands in blank margin. Worth fixing
     independently of the part-assembly work.
   - The remaining genuine *recognition* gap is then the note errors (recall on a
     dense early-music engraving), in the same family as fix 1.

3. **Simple-vs-compound meter (`saltarello`).** Closing the last `6/8`→`3/4`
   affordance needs a beat-grouping/beaming signal. TrOMR emits no beam tokens,
   so this is a genuine model-input gap, not a builder fix — lowest priority of
   the three, and tracked here so the affordance isn't mistaken for a bug.
