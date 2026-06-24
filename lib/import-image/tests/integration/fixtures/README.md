# OMR integration-test fixtures

Input images **and source scores** for the end-to-end OMR integration tests
(`../import-image.spec.ts`). Each `<name>.png` is fed through the *actual*
recognition pipeline, and the recovered MusicXML is diffed against
`<name>.source.musicxml` (the original score) — so the source is the test oracle,
not provenance. The recovered output itself is not committed. `COMPARISON.md`
explains the diff/affordance model and the path to a fully source-based suite.

## Provenance & license

Most fixtures are from the **MusicXML example set** published at
<https://www.musicxml.com/music-in-musicxml/example-set/>. Per that page the
example files are provided for testing and demonstrating MusicXML software. Those
`.png` images and `.musicxml` sources are taken unmodified from that set (renamed
to kebab-case).

The `gabriels-bell` and `elgar-ave-verum` fixtures are from **CPDL / ChoralWiki**
(<https://www.cpdl.org/>), whose scores are free to use under the CPDL license.
For these the `.png` is **rendered from the score's PDF** with the editor's own
pdf.js renderer (the same 2200px-long-edge raster `decode.ts` produces; the three
Elgar pages are stitched vertically into one image), and the `.source.musicxml` is
the MusicXML extracted from the score's `.mxl` (zip) container. Note `gabriels-bell`'s
source is a PDFtoMusic auto-conversion, not a hand-authored score — see the spec.

| fixture                  | source name         | provenance    | complexity                                              |
| ------------------------ | ------------------- | ------------- | ------------------------------------------------------- |
| `chant`                  | `Chant`             | musicxml.com  | single staff, one measure — the simplest case           |
| `saltarello`             | `Saltarello`        | musicxml.com  | single part over several systems (22 measures)          |
| `mozart-piano-sonata`    | `MozartPianoSonata` | musicxml.com  | grand staff (treble + bass, two staves)                 |
| `binchois`               | `Binchois`          | musicxml.com  | four staves / two bass-clef systems                     |
| `gabriels-bell`          | `Gabriel's Bell`    | CPDL          | one staff of bell-chords split into two treble parts    |
| `elgar-ave-verum`        | `Elgar - Ave Verum` | CPDL          | SATB choir + organ, three pages — the most complex      |

The set is deliberately a **range of complexity**, not just single-staff scores.

## What each fixture asserts

Every fixture is an ordinary test that (1) diffs the recovered MusicXML against
its source score, allowing only the differences codified in the spec's
`EXPECTED_DIFFERENCES`, and (2) asserts an OpenSheetMusicDisplay screenshot. See
`COMPARISON.md` for how the diff works and why it ratchets.

`binchois`, `gabriels-bell`, and `elgar-ave-verum` are currently in
`SKIPPED_FIXTURES` (see the spec): each is a multi-part score the single-part
pipeline flattens, so the recovery differs from the source structurally (e.g.
`gabriels-bell` recovers one 29-measure part against a 58-measure two-part source)
and the flat note order is scrambled. They are written as full tests but skipped
with a `TODO`, so each stays a visible reminder to improve the OMR rather than
being downgraded to a weaker assertion. Unskip a name once the pipeline recovers
it correctly (this needs multi-part assembly and a part-aware diff — see the spec
and `COMPARISON.md`).

## Adding a fixture

1. Drop `<name>.png` **and** `<name>.source.musicxml` here (the source is the
   test oracle — the diff needs it).
2. Add a `<name>` entry to `EXPECTED_DIFFERENCES` in the spec listing the
   currently-expected differences (run the test once to see them reported).
3. Regenerate the screenshot: `make omr-integration-test ARGS=--update-snapshots`.
   If the OMR cannot yet recover it well enough to render, add `<name>` to
   `SKIPPED_FIXTURES` with a `TODO` instead.
4. Review the new `../__snapshots__/<name>.png` and commit it with the fixture.
