# HOMR accuracy comparison

**Date:** 2026-06-25  
**HOMR version:** 0.6.2 (PyPI)  
**Our pipeline:** v2 weights, classical staff detection

We ran [HOMR](https://github.com/liebharc/homr) (the AGPL-3.0 Python project our
TypeScript pipeline uses as a reference) on the same six fixture images, diffed
its output against the source scores with the same `computeDifferences` engine,
and compared the results. See `scripts/run-homr.py` and `scripts/compare-homr.ts`
(invoked via `make homr-comparison`).

## Results

| fixture | HOMR diffs | our diffs | verdict |
| --- | ---: | ---: | --- |
| chant | 2 | 1 | ours wins |
| saltarello | **0** | 1 | HOMR wins |
| mozart-piano-sonata | 18 | **3** | ours wins |
| binchois | 117 | skipped | — |
| gabriels-bell | 133 | skipped | — |
| elgar-ave-verum | 114 | skipped | — |

### Per-fixture notes

**chant** — HOMR loses the time signature entirely (`time: senza-misura → none`)
and splits the single measure into two. Our pipeline recovers the barline
correctly but defaults to 4/4 instead of senza-misura.

**saltarello** — HOMR recovers the score perfectly (0 differences). Our pipeline
gets the measure length right but infers 3/4 instead of 6/8 because
simple-vs-compound is not recoverable from note durations alone.

**mozart-piano-sonata** — Our pipeline has 3 differences (1 wrong accidental,
2 wrong pitches, all in dense low-bass grace notes). HOMR has 18: it loses the
meter (`time: 2/4 → none`), misses a measure, and misreads many notes in the
same bass passages. Our implementation is considerably more accurate here.

**Multi-part fixtures (binchois, gabriels-bell, elgar-ave-verum)** — HOMR has
the same fundamental limitation as our single-part pipeline: it reduces
multi-part scores to a single part, producing the same structural divergences
(halved clef count, halved measure count) and consequently hundreds of alignment
artifacts.

## Conclusion

HOMR is not worth pursuing as an alternative or supplement to our pipeline:

- On the two non-trivial non-skipped fixtures our pipeline wins (3 vs 18
  differences on mozart, 1 vs 2 on chant).
- HOMR's one win — saltarello's 6/8 meter — is due to it having a dedicated
  compound-meter classifier that our pipeline deliberately omits (we infer meter
  from note durations, which cannot distinguish 6/8 from 3/4). That specific gap
  could be closed without adopting HOMR.
- HOMR is AGPL-3.0 and Python; integrating it into the browser pipeline is not
  possible, and running it server-side would be a significant architectural change
  for minimal accuracy gain.
- The `make homr-comparison` tooling stays in the repo as a reference benchmark
  if the comparison is ever worth revisiting.
