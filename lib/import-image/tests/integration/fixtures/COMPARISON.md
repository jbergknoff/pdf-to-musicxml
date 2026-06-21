# Source-vs-recovered MusicXML comparison

The OMR integration tests currently assert the recovered MusicXML against a
**frozen snapshot** of today's (imperfect) output. The goal we are moving toward
is to assert the recovered output **against the `*.source.musicxml`** — the real
score — modulo a small set of *explicitly-codified expected differences*. This
file quantifies the gap so we know what those codified differences are and how
big the genuine recognition errors still are.

Regenerate the numbers with `make compare-fixtures`
(`helpers/compare-musicxml.ts`). It reduces both files to an order-preserving
stream of pitched notes, aligns them (Needleman–Wunsch), and reports pitch
recall/precision, accidental accuracy on matched notes, the document attribute
diffs, and the source features the OMR drops.

## Current numbers

| fixture               | notes (src→rec) | measures | pitch recall | pitch precision | accidental | wrong / missed / spurious |
| --------------------- | --------------- | -------- | ------------ | --------------- | ---------- | ------------------------- |
| `chant`               | 27 → 27         | 1 → 1    | **100%**     | **100%**        | 100%       | 0 / 0 / 0                 |
| `saltarello`          | 112 → 112       | 22 → 22  | **100%**     | **100%**        | 100%       | 0 / 0 / 0                 |
| `mozart-piano-sonata` | 70 → 53         | 5 → 5    | 57%          | 76%             | 98%        | 11 / 19 / 2               |
| `binchois`            | 160 → 131       | 34 → 23  | 51%          | 63%             | 96%        | 20 / 58 / 29              |

(Pitch alignment compares step + octave; accidental accuracy is reported
separately, over the matched notes.)

## What the differences are

### 1. Expected differences (codify, then ignore in the assertion)

These hold even on the two fixtures the OMR recovers perfectly, so they are
properties of the pipeline, not recognition errors:

- **Document/notational features the builder never emits.** Every source carries
  some of: `lyric`, `slur`, `tie`, `direction`, `dynamics`, `articulations`,
  `ornaments`, `stem`, `grace`, `tuplet`, `fermata`. The OMR targets pitches and
  rhythm only, so these are dropped by design. (`EXPECTED_DROPPED_FEATURES` in
  the comparator lists them.)
- **`divisions` normalization.** Sources encode at `divisions=8`; the builder
  emits `divisions=4`. Same musical durations, different unit — compare durations
  in beats, not raw `<duration>`.
- **Header/layout metadata.** `movement-title`, `identification`, `defaults`,
  `print`, `default-x`/`default-y`, MIDI instrument blocks — none are recovered.

### 2. Genuine recognition errors (the OMR's actual job — drive these down)

- **Time signature is always wrong.** TrOMR did not emit a time signature for any
  of the four, so the builder defaults to `4/4` — even where the source is `6/8`
  (`saltarello`), `2/4` (`mozart`), `3/4` (`binchois`), or `senza-misura`
  (`chant`). This is the single most consistent error and the highest-value fix:
  it is *almost* codifiable as "expected", but it is genuinely wrong output, so
  it belongs here, not in §1.
- **Dropped / spurious / mis-pitched notes** on the dense scores: `mozart` loses
  19 notes (43% recall miss) and `binchois` 58. Accidentals, once a note is found,
  are essentially correct (96–100%) — the weakness is *finding and placing* notes,
  not spelling them.
- **Missing staves / measures on multi-system pages.** `binchois` is four
  bass-clef staves across two systems; only two staves' worth of clefs and 23 of
  34 measures survive. This is why it over-fills a measure and OSMD refuses to
  engrave it — hence it is currently in `SKIPPED_FIXTURES`.

## Toward asserting against the source

A source-based assertion would, per fixture:

1. Normalize both scores to the comparator's pitched-note stream + per-measure
   beat durations (folding away §1: drop the listed features, normalize
   `divisions`, ignore layout/metadata).
2. Assert pitch recall/precision and accidental accuracy **at or above a
   per-fixture threshold** (100% for `chant`/`saltarello`; a tracked,
   ratcheting floor for `mozart`/`binchois`).
3. Assert the recovered key/clef equal the source; assert the time signature
   equals the source **once TrOMR emits it** (today this would fail every
   fixture — the one codified exception to remove first).

The two perfect fixtures (`chant`, `saltarello`) could move to a strict
source-equality assertion immediately, modulo §1 and the time signature. The
remaining gap to a fully source-based suite is the time-signature recovery plus
raising the dense-score recall.
