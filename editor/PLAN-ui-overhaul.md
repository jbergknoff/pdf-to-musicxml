# Plan: Selection-first UI overhaul — next steps

## Context

The editor has been overhauled to the **selection-first, keyboard-driven** model
from the Claude Design handoff (PR #24). The work was built on the editor's
**existing custom SVG renderer** rather than migrating to OpenSheetMusicDisplay:
the renderer (`editor/src/sheet-music/`) already implements the same
overlay/highlight/hit-test/cursor architecture the handoff calls for, so adopting
the design's *interaction model and chrome* onto it satisfied the OSMD
recommendation in spirit without a risky rewrite.

This doc records what shipped and captures the prioritized **next steps** — the
highest-impact being a pre-existing hit-test inaccuracy surfaced during the work.
It continues the `editor/PLAN.md` → `editor/PLAN-foundation.md` milestone series.

### What shipped (PR #24)

- **`dom-edit.ts`** — chord-aware `writeMeasure` (emits `<chord/>` on stacked
  notes, ordered low-to-high), plus `setAccidental`, `addNoteToChord`, and
  `insertMeasure`, all preserving the beat-budget invariant and untouched-element
  fidelity.
- **`hit-test.ts`** — `ChordInfo` (id + pitch + type per note),
  `chordInfoForHandle` / `chordInfoAtBeat` / `chordInfos`, `topFirstNotes`, and
  `octavePitch` for the inspector and beat navigation.
- **`components/Inspector.tsx`** (new) — the right panel: level badge, time-position
  header, top-first note rows (accidental segmented control, ▲▼ steppers, ✕
  remove), Add note, and empty state.
- **`Editor.tsx`** — the new toolbar + instruction-strip + transport shell on
  `theme.ts` design tokens, the full keyboard map (Esc/Enter/Tab, ↑↓ pitch with
  Shift octave, ←→ beat navigation, A–G add, −/=/0 accidentals, Space listen), and
  the inspector + listen wiring.
- **`use-listen.ts`** (new) — a WebAudio triangle step-synth stepping ~600 ms/beat
  from the selected beat, driving the renderer's existing `getLiveBeat`/`isPlaying`
  cursor and scroll-follow.
- **`theme.ts`** (new) + `index.html` — design tokens and IBM Plex / Noto Music
  fonts (system fallback under COEP).
- **Tests** — chord/accidental/measure unit tests in `dom-edit.test.ts`, and a new
  `editor/tests/selection-loop.spec.ts` Playwright spec (drill, inspector edits,
  Esc step-out, letter add, + Measure). The original `editing-flows.spec.ts` still
  passes.

Scope: single treble staff (matching the prototype). Multi-staff / multi-voice
documents remain **view-only** (`isEditableDocument`).

---

## Immediate follow-ups (polish / correctness)

### 1. Hit-test accuracy (highest impact)

`beatFromX` (`editor/src/hit-test.ts`) maps x→beat **linearly** across the measure
width, ignoring the clef/key/time lead-in that pushes the first note well to the
right of the barline. As a result a click on a notehead can resolve to a
*neighboring* beat (e.g. clicking the C5 glyph selects the next beat). The
`selection-loop.spec.ts` tests are written pitch-agnostically to tolerate this; it
is the main thing that makes the loop feel imprecise.

**Fix (per the handoff §3):** resolve a click to the nearest beat by x-distance to
the *actual* onset positions instead of linear interpolation. Reuse
`layout.measureSpines` — `MeasureSpine.divs`/`xs` (`sheet-music/sheet-music-types.ts`)
give the real per-onset x within a measure — or invert `computeCursorX`
(`sheet-music/SheetMusicDisplay.tsx`). Once landed, tighten `selection-loop.spec.ts`
to assert specific pitches.

### 2. Direct notehead → Level 2 shortcut

The handoff allows clicking *directly on a notehead* to jump straight to Level 2
(skipping the intermediate beat selection). Add this branch to `handleTap` in
`Editor.tsx`. Depends on #1 for a trustworthy "directly on a notehead" signal
(the current `gesture.hit` tolerance is loose).

### 3. Selection overlay chrome (medium-fidelity, deferred from the overhaul)

Selection is currently conveyed by recoloring noteheads. Add the design's richer
overlay: a tinted **beat-box** rect (Level 1), a **note ring** on the drilled note
(Level 2), and a pulsing **play-cursor box**. Implement as a new overlay layer in
`SheetMusicDisplay.tsx` keyed off a `selectionBox`/`focusRing` prop, positioned
from `computeCursorX(onsetBeat)` (x) and `layout.staffBottomYs` (y). The tokens
already exist in `theme.ts` (`accentHighlight`, `accentBorder`, `accentRingFill`,
`greenCursorFill`/`greenCursorBorder`).

### 4. Reselect after removing a chord member

`removeHandle` in `Editor.tsx` clears the selection after removing a note. For a
multi-note chord, re-resolve and reselect the remaining beat after `commit()` so
the inspector stays on the chord the user was editing.

### 5. Enharmonic spelling by key signature

`stepPitch` (`hit-test.ts`) resets the alteration to natural (a C-major
assumption), and `setAccidental` writes a raw `alter`. The handoff specifies
(decided) that ↑/↓ stay **diatonic in the active key** and chromatic edits
**respell to the key signature** (F♯ in G major, G♭ in D♭ major). Reuse the
parser's `keyAlterForStep` and per-measure `activeFifths`
(`sheet-music/musicxml-parser.ts`).

---

## Larger deferred features (in the spec, not in the prototype)

Each is its own milestone.

6. **Multi-staff (grand-staff) editing** — extend `dom-edit` + parser provenance
   past the single-voice `isEditableDocument` guard so grand-staff scores become
   editable; ↑/↓ at Level 1 can cross staves while inside a chord they re-pitch.
7. **Grace notes** — a selection sub-level attached to a parent note; `G` adds,
   ←/→ step into/out of the grace group.
8. **Durations, ties, beaming** — a duration palette (1–5 + dot), `T` to tie across
   a barline, `B` to break/join beams; lengthening absorbs following rests and
   overflow past the barline is carried by a tie. (Beaming already auto-renders via
   `groupBeamableEvents`.)
9. **Measure-range selection + copy/cut/paste** — a third selection mode above the
   note level; cut removes measures and pulls later ones left, paste inserts before
   the selected measure. Pairs with the existing `focusRange` scrubber in
   `SheetMusicDisplay.tsx`.
10. **Import confirm steps** — MIDI quantize / staff-split confirmation; OMR results
    landing in a cleanup mode. (Type routing already exists in `Editor.tsx`'s
    `onImport`.)
11. **Touch adaptations** — 44 px hit targets, the inspector as a bottom sheet on
    narrow screens, and tap / tap-again parity with the mouse two-click path.

---

## Polish / infra

12. **Configurable tempo + range playback** — the transport shows a fixed ♩ = 100;
    make it adjustable and let Listen play a selected measure range. `use-listen.ts`
    already steps a flat beat list and accepts a `fromBeat`, so this is mostly UI +
    an end-beat bound.
13. **Self-host fonts** — `index.html` loads IBM Plex / Noto Music from Google
    Fonts, which the page's COOP/COEP isolation may block (the theme's font stacks
    fall back to system fonts). Self-host the woff2 files under the static deploy for
    reliable rendering.

---

## Suggested order

Do **#1 (hit-test accuracy) first** — it unblocks #2 and is what makes the whole
selection loop feel right — then #3–#5 as polish, then the larger features (#6–#11)
as their own milestones. Each follow-up is a self-contained PR; run `make pr-ready`
(format, lint, typecheck, build, unit-test) plus `make editor-integration-test`
before committing.
