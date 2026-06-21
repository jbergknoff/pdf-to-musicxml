# OMR integration-test fixtures

Input images **and source scores** for the end-to-end OMR integration tests
(`../import-image.spec.ts`). Each `<name>.png` is fed through the *actual*
recognition pipeline, and the recovered MusicXML is diffed against
`<name>.source.musicxml` (the original score) — so the source is the test oracle,
not provenance. The recovered output itself is not committed. `COMPARISON.md`
explains the diff/affordance model and the path to a fully source-based suite.

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

Every fixture is an ordinary test that (1) diffs the recovered MusicXML against
its source score, allowing only the differences codified in the spec's
`EXPECTED_DIFFERENCES`, and (2) asserts an OpenSheetMusicDisplay screenshot. See
`COMPARISON.md` for how the diff works and why it ratchets.

`binchois` is currently in `SKIPPED_FIXTURES` (see the spec): the OMR drops a
third of its measures and over-fills one, so OSMD/VexFlow refuses to engrave it —
the same failure the editor's ScoreView surfaces. It is written as a full test
but skipped with a `TODO`, so it stays a visible reminder to improve the OMR
rather than being downgraded to a weaker assertion. Unskip it once the pipeline
recovers it correctly.

## Adding a fixture

1. Drop `<name>.png` **and** `<name>.source.musicxml` here (the source is the
   test oracle — the diff needs it).
2. Add a `<name>` entry to `EXPECTED_DIFFERENCES` in the spec listing the
   currently-expected differences (run the test once to see them reported).
3. Regenerate the screenshot: `make omr-integration-test ARGS=--update-snapshots`.
   If the OMR cannot yet recover it well enough to render, add `<name>` to
   `SKIPPED_FIXTURES` with a `TODO` instead.
4. Review the new `../__snapshots__/<name>.png` and commit it with the fixture.
