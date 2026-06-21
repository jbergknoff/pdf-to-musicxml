# OMR integration-test fixtures

Input images for the end-to-end OMR integration tests
(`../import-image.spec.ts`). Each `<name>.png` is fed through the *actual*
recognition pipeline; `<name>.source.musicxml` is the original score. The tests
assert against the recovered output in `../__snapshots__/`, not against this
source — but `make compare-fixtures` (`../helpers/compare-musicxml.ts`) measures
how far the recovered output is from the source, and `COMPARISON.md` writes up
those numbers and the path toward asserting against the source directly.

## Provenance & license

These are from the **MusicXML example set** published at
<https://www.musicxml.com/music-in-musicxml/example-set/>. Per that page the
example files are provided for testing and demonstrating MusicXML software. The
`.png` images and `.musicxml` sources here are taken unmodified from that set
(renamed to kebab-case).

| fixture                  | source name         | complexity                                              |
| ------------------------ | ------------------- | ------------------------------------------------------- |
| `chant`                  | `Chant`             | single staff, one measure — the simplest case           |
| `saltarello`             | `Saltarello`        | single part over several systems (22 measures)          |
| `mozart-piano-sonata`    | `MozartPianoSonata` | grand staff (treble + bass, two staves)                 |
| `binchois`               | `Binchois`          | four staves / two bass-clef systems — the most complex  |

The set is deliberately a **range of complexity**, not just single-staff scores.

## What each fixture asserts

Every fixture is an ordinary test that asserts the recovered MusicXML against a
committed snapshot **and** an OpenSheetMusicDisplay screenshot of it.

`binchois` is currently in `SKIPPED_FIXTURES` (see the spec): the OMR loses ~12%
of its notes and a third of its measures and over-fills a measure, so OSMD/VexFlow
refuses to engrave it — the same failure the editor's ScoreView surfaces. It is
written as a full (content + screenshot) test but skipped with a `TODO`, so it
stays a visible reminder to improve the OMR rather than being downgraded to a
weaker assertion. Unskip it once the pipeline recovers it correctly.

## Adding a fixture

1. Drop `<name>.png` (and optionally `<name>.source.musicxml`) here.
2. Regenerate baselines: `make omr-integration-test ARGS=--update-snapshots`.
3. If the OMR cannot yet recover it well enough to render, add `<name>` to
   `SKIPPED_FIXTURES` with a `TODO` (don't downgrade the assertion).
4. Review the new `../__snapshots__/<name>.*` and commit them.
