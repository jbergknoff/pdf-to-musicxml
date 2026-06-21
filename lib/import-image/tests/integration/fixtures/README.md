# OMR integration-test fixtures

Input images for the end-to-end OMR integration tests
(`../import-image.spec.ts`). Each `<name>.png` is fed through the *actual*
recognition pipeline; `<name>.source.musicxml` is the original score kept for
provenance only (the tests never read it — they assert against the recovered
output in `../__snapshots__/`, not against this source).

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

Every fixture asserts the recovered MusicXML against a committed snapshot. Most
also assert an OpenSheetMusicDisplay screenshot of that MusicXML. `binchois` is
**content-only** (see `CONTENT_ONLY_FIXTURES` in the spec): the imperfect OMR
output over-fills a measure, so OSMD/VexFlow refuses to engrave it — the same
failure the editor's ScoreView surfaces. We still lock its MusicXML as a
regression baseline.

## Adding a fixture

1. Drop `<name>.png` (and optionally `<name>.source.musicxml`) here.
2. Regenerate baselines: `make omr-integration-test ARGS=--update-snapshots`.
3. If OSMD cannot render the result, add `<name>` to `CONTENT_ONLY_FIXTURES`.
4. Review the new `../__snapshots__/<name>.*` and commit them.
