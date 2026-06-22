/**
 * Classical (model-free) transcription for born-digital sheet music.
 *
 * For clean, computer-generated scores the symbols have precise geometry
 * relative to the known staff unit size, so note pitch and duration can be
 * read by rule-based image analysis alone — no ONNX models needed. The
 * pipeline per staff:
 *
 *   1. Binarize the staff crop with Otsu's threshold.
 *   2. Remove the five known staff lines (paint white ±1 px), then apply a
 *      2-pixel vertical morphological closing to bridge the small gaps that
 *      removal creates in stems and noteheads sitting on a line.
 *   3. Label connected components (4-connected, union-find).
 *   4. Classify each component by bounding-box dimensions and local pixel
 *      density relative to the staff unit size.
 *   5. Read the staff header left-to-right: clef → key accidentals → time digits.
 *   6. Map each notehead's y-coordinate to a diatonic pitch via the clef.
 *   7. Determine duration from notehead shape (open vs. filled), total
 *      component height (stem presence), and nearby beam components.
 *   8. Assign measure indices by counting barlines to the left of each note.
 *
 * Handles: whole, half, quarter, eighth, sixteenth notes and rests; treble and
 * bass clefs; key signatures up to 7 sharps/flats; common time signatures;
 * chords; augmentation dots; note accidentals (sharp/flat/natural).
 *
 * Unrecognised symbols are skipped rather than errored; uncertain clef/time
 * defaults to treble/4/4.
 */

import type { NoteEvent, RgbaImage, ScoreAttributes, Staff, Transcription } from "../types";
import { otsuThreshold } from "../staves/classical-staff-mask";
import { cropStaff } from "./staff-crop";
import type { TranscribeOptions } from "./transcribe";

// ─── Connected-component data ─────────────────────────────────────────────────

interface Component {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  pixelCount: number;
  /** Sum of x-coordinates of all pixels (for centroid.x = sumX / pixelCount). */
  sumX: number;
  /** Sum of y-coordinates of all pixels (for centroid.y = sumY / pixelCount). */
  sumY: number;
}

function compWidth(c: Component): number {
  return c.x1 - c.x0 + 1;
}

function compHeight(c: Component): number {
  return c.y1 - c.y0 + 1;
}

function centroidX(c: Component): number {
  return c.sumX / c.pixelCount;
}

function centroidY(c: Component): number {
  return c.sumY / c.pixelCount;
}

// ─── Image helpers ─────────────────────────────────────────────────────────────

function lumaAt(data: Uint8ClampedArray, index: number): number {
  return Math.round(
    0.299 * data[index] + 0.587 * data[index + 1] + 0.114 * data[index + 2],
  );
}

/** Binarize an RGBA image using Otsu's threshold. Returns 1=ink, 0=background. */
function binarize(image: RgbaImage): Uint8Array {
  const { data, width, height } = image;
  const pixelCount = width * height;
  const histogram = new Int32Array(256);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    histogram[lumaAt(data, pixel * 4)]++;
  }
  const threshold = otsuThreshold(histogram, pixelCount);
  const ink = new Uint8Array(pixelCount);
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    ink[pixel] = lumaAt(data, pixel * 4) <= threshold ? 1 : 0;
  }
  return ink;
}

/**
 * Vertical morphological closing with the given radius. Bridges vertical gaps
 * of up to `2 * radius` pixels in each column without affecting horizontal
 * structure. Used after staff-line removal and again after beam suppression.
 */
function verticalClose(
  ink: Uint8Array,
  width: number,
  height: number,
  radius: number,
): Uint8Array {
  const dilated = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (ink[y * width + x] === 1) {
        const yStart = Math.max(0, y - radius);
        const yEnd = Math.min(height - 1, y + radius);
        for (let dy = yStart; dy <= yEnd; dy++) {
          dilated[dy * width + x] = 1;
        }
      }
    }
  }
  const closed = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (dilated[y * width + x] === 0) continue;
      let allSet = true;
      const yStart = Math.max(0, y - radius);
      const yEnd = Math.min(height - 1, y + radius);
      for (let dy = yStart; dy <= yEnd; dy++) {
        if (dilated[dy * width + x] === 0) {
          allSet = false;
          break;
        }
      }
      if (allSet) closed[y * width + x] = 1;
    }
  }
  return closed;
}

/**
 * Remove staff lines from an ink mask (paint white at each known line row ±1
 * pixel), then apply a 2-pixel vertical morphological closing to bridge the
 * small gaps the erasure creates in stems and noteheads that sit on a line.
 * The closing radius is deliberately small — it bridges the ~3-pixel gap from
 * line removal without merging symbols that are a unit size apart.
 */
function removeStaffLinesAndClose(
  ink: Uint8Array,
  width: number,
  height: number,
  lineYs: number[],
): Uint8Array {
  const erased = ink.slice();
  for (const lineY of lineYs) {
    const y0 = Math.max(0, Math.round(lineY) - 1);
    const y1 = Math.min(height - 1, Math.round(lineY) + 1);
    for (let y = y0; y <= y1; y++) {
      erased.fill(0, y * width, y * width + width);
    }
  }
  return verticalClose(erased, width, height, 2);
}

// ─── Connected-component labeling ─────────────────────────────────────────────

function findRoot(parent: Int32Array, index: number): number {
  let root = index;
  while (parent[root] !== root) {
    root = parent[root];
  }
  let current = index;
  while (current !== root) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function unite(parent: Int32Array, rank: Uint8Array, a: number, b: number): void {
  const ra = findRoot(parent, a);
  const rb = findRoot(parent, b);
  if (ra === rb) return;
  if (rank[ra] < rank[rb]) {
    parent[ra] = rb;
  } else if (rank[ra] > rank[rb]) {
    parent[rb] = ra;
  } else {
    parent[rb] = ra;
    rank[ra]++;
  }
}

/**
 * Remove long horizontal runs (beams) from an ink mask before CC labeling so
 * that beams do not merge with the noteheads/stems they connect. Returns the
 * beam-free ink and the beam CCs (already labeled, for later classification).
 * Any horizontal run of ink >= 2.5u wide is treated as a beam candidate.
 */
function suppressBeams(
  ink: Uint8Array,
  width: number,
  height: number,
  unitSize: number,
): { inkWithoutBeams: Uint8Array; beamComponents: Component[] } {
  const minBeamWidth = Math.round(2.5 * unitSize);
  const beamInk = new Uint8Array(width * height);
  const inkWithoutBeams = ink.slice();

  for (let y = 0; y < height; y++) {
    let runStart = -1;
    for (let x = 0; x <= width; x++) {
      const isInk = x < width && ink[y * width + x] === 1;
      if (isInk && runStart === -1) {
        runStart = x;
      } else if (!isInk && runStart !== -1) {
        if (x - runStart >= minBeamWidth) {
          for (let bx = runStart; bx < x; bx++) {
            beamInk[y * width + bx] = 1;
            inkWithoutBeams[y * width + bx] = 0;
          }
        }
        runStart = -1;
      }
    }
  }

  const beamComponents = labelComponents(beamInk, width, height).filter((c) => {
    const w = compWidth(c);
    const h = compHeight(c);
    const density = c.pixelCount / (w * h);
    return w >= minBeamWidth && h < Math.round(0.75 * unitSize) && density > 0.6;
  });

  return { inkWithoutBeams, beamComponents };
}

/** 4-connected component labeling via union-find. */
function labelComponents(ink: Uint8Array, width: number, height: number): Component[] {
  const n = width * height;
  const parent = new Int32Array(n);
  const rank = new Uint8Array(n);
  for (let i = 0; i < n; i++) parent[i] = i;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (ink[i] === 0) continue;
      if (x > 0 && ink[i - 1] === 1) unite(parent, rank, i, i - 1);
      if (y > 0 && ink[i - width] === 1) unite(parent, rank, i, i - width);
    }
  }

  const map = new Map<number, Component>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (ink[i] === 0) continue;
      const root = findRoot(parent, i);
      const existing = map.get(root);
      if (existing === undefined) {
        map.set(root, { x0: x, y0: y, x1: x, y1: y, pixelCount: 1, sumX: x, sumY: y });
      } else {
        if (x < existing.x0) existing.x0 = x;
        if (x > existing.x1) existing.x1 = x;
        if (y < existing.y0) existing.y0 = y;
        if (y > existing.y1) existing.y1 = y;
        existing.pixelCount++;
        existing.sumX += x;
        existing.sumY += y;
      }
    }
  }
  return Array.from(map.values());
}

// ─── Component classification ─────────────────────────────────────────────────

type SymbolKind =
  | "barline"
  | "clef"
  | "beam"
  | "rest-block"
  | "notehead-filled"
  | "notehead-open"
  | "dot"
  | "sharp"
  | "flat"
  | "noise";

interface ClassifiedSymbol {
  component: Component;
  kind: SymbolKind;
}

/**
 * Maximum ink pixels in any single row of the component's bounding box.
 * Used to distinguish wide (notehead-sized) from thin (barline/stem) components.
 */
function maxRowSpan(ink: Uint8Array, comp: Component, imageWidth: number): number {
  let best = 0;
  for (let y = comp.y0; y <= comp.y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) {
      count += ink[y * imageWidth + x];
    }
    if (count > best) best = count;
  }
  return best;
}

/**
 * Row within the component's bounding box that has the most ink pixels —
 * used as the density-sample centre for open/filled discrimination.
 */
function noteheadRow(ink: Uint8Array, comp: Component, imageWidth: number): number {
  let bestCount = 0;
  let bestRow = Math.round((comp.y0 + comp.y1) / 2);
  for (let y = comp.y0; y <= comp.y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) {
      count += ink[y * imageWidth + x];
    }
    if (count > bestCount) {
      bestCount = count;
      bestRow = y;
    }
  }
  return bestRow;
}

/**
 * Y-coordinate to use for pitch estimation: weighted centroid of all rows
 * whose ink count is at least half the per-row maximum. This centres on the
 * notehead body for both filled ovals (where the waist row dominates) and
 * open rings (where the top/bottom strips are dense but the true centre lies
 * between them). Thin stem rows (1 px wide) are well below the threshold and
 * do not pull the centroid away from the notehead.
 */
function notePitchRow(ink: Uint8Array, comp: Component, imageWidth: number): number {
  let maxCount = 0;
  for (let y = comp.y0; y <= comp.y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) {
      count += ink[y * imageWidth + x];
    }
    if (count > maxCount) maxCount = count;
  }
  const threshold = maxCount * 0.5;
  let weightedY = 0;
  let totalWeight = 0;
  for (let y = comp.y0; y <= comp.y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) {
      count += ink[y * imageWidth + x];
    }
    if (count >= threshold) {
      weightedY += y * count;
      totalWeight += count;
    }
  }
  return totalWeight > 0
    ? Math.round(weightedY / totalWeight)
    : Math.round((comp.y0 + comp.y1) / 2);
}

/**
 * Pixel density in a ±0.4u vertical band around `centerY`, restricted to the
 * component's bounding box. Low density (<0.45) indicates an open (half/whole)
 * notehead; high density (>0.52) indicates a filled (quarter/eighth) notehead.
 */
function localDensityAroundRow(
  ink: Uint8Array,
  comp: Component,
  imageWidth: number,
  centerY: number,
  unitSize: number,
): number {
  const halfBand = Math.max(2, Math.round(unitSize * 0.4));
  const y0 = Math.max(comp.y0, centerY - halfBand);
  const y1 = Math.min(comp.y1, centerY + halfBand);
  let ink_count = 0;
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = comp.x0; x <= comp.x1; x++) {
      ink_count += ink[y * imageWidth + x];
      total++;
    }
  }
  return total === 0 ? 0 : ink_count / total;
}

/**
 * Returns true if the component looks like an open (half/whole) notehead ring.
 * Examines rows in a ±0.5u band around nhRow: if any row has fewer than 70% of
 * the band's max ink count, the shape has a sparse interior or an erased-staff-
 * line gap → it is open. Filled noteheads have all rows at ~100% of max.
 */
function isOpenNoteheadShape(
  ink: Uint8Array,
  comp: Component,
  imageWidth: number,
  nhRow: number,
  unitSize: number,
): boolean {
  const halfBand = Math.max(2, Math.round(unitSize * 0.5));
  const y0 = Math.max(comp.y0, nhRow - halfBand);
  const y1 = Math.min(comp.y1, nhRow + halfBand);
  let maxCount = 0;
  for (let y = y0; y <= y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) count += ink[y * imageWidth + x];
    if (count > maxCount) maxCount = count;
  }
  if (maxCount === 0) return false;
  // Only consider rows that carry enough ink to be part of the notehead body
  // (pure stem rows with 1px width are below this threshold and are excluded).
  const candidateMin = maxCount * 0.5;
  for (let y = y0; y <= y1; y++) {
    let count = 0;
    for (let x = comp.x0; x <= comp.x1; x++) count += ink[y * imageWidth + x];
    if (count >= candidateMin && count < maxCount * 0.7) return true;
  }
  return false;
}

function classifyComponent(
  comp: Component,
  ink: Uint8Array,
  imageWidth: number,
  lineYs: number[],
  unitSize: number,
): SymbolKind {
  const u = unitSize;
  const staffHeight = lineYs[4] - lineYs[0]; // ≈ 4u
  const w = compWidth(comp);
  const h = compHeight(comp);
  const density = comp.pixelCount / (w * h);

  // Noise: too small to be meaningful
  if (comp.pixelCount < Math.max(3, u * 0.06)) return "noise";

  const mrs = maxRowSpan(ink, comp, imageWidth);

  // ── Thin CCs (barlines, stem fragments) ──────────────────────────────────
  if (mrs < Math.max(3, u * 0.2)) {
    return h >= 0.7 * staffHeight ? "barline" : "noise";
  }

  // ── Very wide CCs (beams, whole/half rest rectangles) ────────────────────
  // Beams are pre-suppressed by suppressBeams(), but a fallback check here
  // handles any that slip through (e.g. very short beams at the minWidth boundary).
  if (mrs >= 2.5 * u) {
    if (h < 0.75 * u && density > 0.6) {
      return w >= 2.5 * u ? "beam" : "rest-block";
    }
    return "noise";
  }

  // ── Medium blobs (0.2u ≤ maxRowSpan < 2.5u) ──────────────────────────────

  // Clef: very tall AND wider than a notehead+stem (mrs > 1.5u discriminates
  // against notehead+stem compounds whose max row span is ~1u).
  if (h > 3.5 * u && mrs > 1.5 * u) return "clef";

  // Augmentation dot: very small and roughly square
  if (w <= 0.65 * u && h <= 0.65 * u && density > 0.35) return "dot";

  // Accidentals (sharp / flat): taller than wide, checked before the notehead
  // path so a sharp-shaped blob isn't mistaken for a notehead. Minimum width
  // 0.4u prevents two bass-clef dots that merge under closing from passing.
  if (
    h >= 0.75 * u &&
    h <= 2.8 * u &&
    w >= 0.4 * u &&
    w <= 1.3 * u &&
    h >= w * 1.3
  ) {
    return h / w >= 2.2 ? "flat" : "sharp";
  }

  // Notehead-sized blob: whether standalone or with a stem attached
  if (w >= 0.45 * u && w <= 2.0 * u) {
    const nhRow = notePitchRow(ink, comp, imageWidth);
    if (h <= 7 * u) {
      if (isOpenNoteheadShape(ink, comp, imageWidth, nhRow, u)) {
        return "notehead-open";
      }
      return "notehead-filled";
    }
  }

  return "noise";
}

function classifyAll(
  components: Component[],
  ink: Uint8Array,
  imageWidth: number,
  lineYs: number[],
  unitSize: number,
): ClassifiedSymbol[] {
  return components
    .map((c) => ({ component: c, kind: classifyComponent(c, ink, imageWidth, lineYs, unitSize) }))
    .filter((s) => s.kind !== "noise");
}

// ─── Clef detection ───────────────────────────────────────────────────────────

/**
 * Find the leftmost clef-classified component and determine whether it is a
 * treble (G2) or bass (F4) clef. The discriminator is height: a treble clef
 * extends well above the top staff line (its tall spiral reaches ~2u above),
 * while a bass clef stays within or just above the staff.
 *
 * Returns `{ clef, endX }` where `endX` is the pixel column past which the
 * key-signature scan begins. When no clef is found, `clef` is undefined and
 * a small gap from the left edge is used as `endX`.
 */
function detectClef(
  symbols: ClassifiedSymbol[],
  lineYs: number[],
  unitSize: number,
): { clef: ScoreAttributes["clef"] | undefined; endX: number } {
  const clefSymbols = symbols
    .filter((s) => s.kind === "clef")
    .sort((a, b) => a.component.x0 - b.component.x0);

  if (clefSymbols.length === 0) {
    return { clef: undefined, endX: Math.round(unitSize * 2) };
  }

  const comp = clefSymbols[0].component;
  // Use 1u margin so bass-clef dots (just to the right of the body) are
  // excluded from the key-signature scan window.
  const endX = comp.x1 + Math.round(unitSize);
  const topLine = lineYs[0];
  // Treble clef extends above the staff; bass (and C) clefs stay within or just
  // below the top line. Empirically the treble clef reaches ≥0.35u above the top
  // line in rendered scores; 0.35u separates it from bass clefs (which sit at or
  // below the top line, or at most ~0.3u above in drawn/synthetic test shapes).
  const isTreble = comp.y0 < topLine - unitSize * 0.35;

  return {
    clef: isTreble ? { sign: "G", line: 2 } : { sign: "F", line: 4 },
    endX,
  };
}

// ─── Key signature detection ──────────────────────────────────────────────────

/**
 * Count key-signature accidentals (all sharps or all flats) in a horizontal
 * window that starts just after the clef and extends at most 7 accidentals
 * wide (the maximum possible key signature). The first accidental seen
 * determines whether the key is sharp or flat; the count gives the fifths.
 *
 * Returns `keyFifths` (positive = sharps, negative = flats) and `endX`.
 */
function detectKeySignature(
  symbols: ClassifiedSymbol[],
  startX: number,
  unitSize: number,
): { keyFifths: number; endX: number } {
  // Key accidentals appear before the time signature, at most 7 of them,
  // within a horizontal window of 8×unitSize from the clef end.
  const maxKeyWidth = 8 * unitSize;
  const candidates = symbols
    .filter(
      (s) =>
        (s.kind === "sharp" || s.kind === "flat") &&
        centroidX(s.component) > startX &&
        centroidX(s.component) < startX + maxKeyWidth,
    )
    .sort((a, b) => a.component.x0 - b.component.x0);

  if (candidates.length === 0) {
    return { keyFifths: 0, endX: startX };
  }

  const kind = candidates[0].kind;
  // All accidentals in a key signature are the same type; stop at any deviation.
  let count = 0;
  let endX = startX;
  for (const c of candidates) {
    if (c.kind !== kind) break;
    count++;
    endX = Math.max(endX, c.component.x1);
  }

  const keyFifths = kind === "sharp" ? count : -count;
  return { keyFifths, endX: endX + Math.round(unitSize * 0.5) };
}

// ─── Time signature detection ─────────────────────────────────────────────────

/**
 * Count enclosed white regions ("topological holes") in a single binary
 * component. Holes are white areas fully surrounded by ink. The count
 * distinguishes common digits: 0/4/6/9 have 1 hole, 8 has 2, 1/2/3/5/7
 * have 0.
 */
function countHoles(
  ink: Uint8Array,
  comp: Component,
  imageWidth: number,
): number {
  const pw = comp.x1 - comp.x0 + 3; // +1 border on each side
  const ph = comp.y1 - comp.y0 + 3;
  const local = new Uint8Array(pw * ph);

  for (let y = comp.y0; y <= comp.y1; y++) {
    for (let x = comp.x0; x <= comp.x1; x++) {
      local[(y - comp.y0 + 1) * pw + (x - comp.x0 + 1)] = ink[y * imageWidth + x];
    }
  }

  // Flood-fill from the border, marking exterior white pixels with 2.
  const queue: number[] = [];
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      if ((y === 0 || y === ph - 1 || x === 0 || x === pw - 1) && local[y * pw + x] === 0) {
        local[y * pw + x] = 2;
        queue.push(y * pw + x);
      }
    }
  }
  while (queue.length > 0) {
    const idx = queue.pop()!;
    const fy = Math.floor(idx / pw);
    const fx = idx % pw;
    for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
      const ny = fy + dy;
      const nx = fx + dx;
      if (ny >= 0 && ny < ph && nx >= 0 && nx < pw) {
        const ni = ny * pw + nx;
        if (local[ni] === 0) {
          local[ni] = 2;
          queue.push(ni);
        }
      }
    }
  }

  // Any remaining white (value 0) is an interior hole; count distinct regions.
  const visited = new Uint8Array(pw * ph);
  let holes = 0;
  for (let y = 0; y < ph; y++) {
    for (let x = 0; x < pw; x++) {
      const i = y * pw + x;
      if (local[i] === 0 && visited[i] === 0) {
        holes++;
        const hq = [i];
        visited[i] = 1;
        while (hq.length > 0) {
          const hi = hq.pop()!;
          const hy = Math.floor(hi / pw);
          const hx = hi % pw;
          for (const [dy, dx] of [[-1, 0], [1, 0], [0, -1], [0, 1]] as const) {
            const ny = hy + dy;
            const nx = hx + dx;
            if (ny >= 0 && ny < ph && nx >= 0 && nx < pw) {
              const ni = ny * pw + nx;
              if (local[ni] === 0 && visited[ni] === 0) {
                visited[ni] = 1;
                hq.push(ni);
              }
            }
          }
        }
      }
    }
  }
  return holes;
}

/**
 * Recognize a single time-signature digit from its topology and aspect ratio.
 * Returns the digit value (1-16) or 0 when uncertain.
 *
 * Rules:
 *   2 holes → 8
 *   1 hole, aspect ratio (h/w) > 1.4 → 4 (tall, enclosed triangle at top)
 *   1 hole, aspect ratio ≤ 1.4 → 6 (wide loop at bottom)
 *   0 holes, aspect ratio > 2.5 → 1 (very tall and narrow)
 *   0 holes, lower 25% has more than 35% of total ink → 2 (horizontal bottom stroke)
 *   0 holes, otherwise → 3 (two bumps, no horizontal base)
 */
function recognizeDigit(
  comp: Component,
  ink: Uint8Array,
  imageWidth: number,
): number {
  const holes = countHoles(ink, comp, imageWidth);
  const h = compHeight(comp);
  const w = compWidth(comp);
  const aspectRatio = h / Math.max(1, w);

  if (holes >= 2) return 8;
  if (holes === 1) {
    return aspectRatio > 1.4 ? 4 : 6;
  }
  // 0 holes
  if (aspectRatio > 2.5) return 1;

  // Count ink in the bottom 25% of the bounding box to distinguish 2 from 3.
  const quarterHeight = Math.max(1, Math.round(h * 0.25));
  const bottomY0 = comp.y1 - quarterHeight;
  let bottomInk = 0;
  for (let y = bottomY0; y <= comp.y1; y++) {
    for (let x = comp.x0; x <= comp.x1; x++) {
      bottomInk += ink[y * imageWidth + x];
    }
  }
  const bottomFraction = bottomInk / Math.max(1, comp.pixelCount);
  return bottomFraction > 0.30 ? 2 : 3;
}

/**
 * Detect the time signature from candidate components in the header region
 * (just after the key signature). The time signature is one or two digit-like
 * blobs (numerator stacked over denominator). Returns the detected time object
 * and the x-position where notes begin.
 */
function detectTimeSignature(
  symbols: ClassifiedSymbol[],
  startX: number,
  unitSize: number,
  ink: Uint8Array,
  imageWidth: number,
): { time: ScoreAttributes["time"] | undefined; endX: number } {
  const u = unitSize;
  // Digit-like blobs: width 0.6–2u, height 1.2–3u, in the time-sig window.
  const timeWindow = 5 * u;
  const candidates = symbols
    .filter((s) => {
      const w = compWidth(s.component);
      const h = compHeight(s.component);
      const cx = centroidX(s.component);
      return (
        cx > startX &&
        cx < startX + timeWindow &&
        w >= 0.55 * u &&
        w <= 2.2 * u &&
        h >= 1.2 * u &&
        h <= 3.0 * u &&
        (s.kind === "sharp" ||
          s.kind === "notehead-filled" ||
          s.kind === "notehead-open" ||
          s.kind === "flat")
      );
    })
    .sort((a, b) => a.component.y0 - b.component.y0);

  if (candidates.length < 2) {
    return { time: undefined, endX: startX };
  }

  // Two stacked blobs: the upper is the numerator, lower is denominator.
  const upper = candidates[0];
  const lower = candidates[1];

  // Sanity check: they should be roughly x-aligned (same time sig column).
  const upperCx = centroidX(upper.component);
  const lowerCx = centroidX(lower.component);
  if (Math.abs(upperCx - lowerCx) > 2 * u) {
    return { time: undefined, endX: startX };
  }

  const beats = recognizeDigit(upper.component, ink, imageWidth);
  const beatType = recognizeDigit(lower.component, ink, imageWidth);

  if (beats === 0 || beatType === 0) {
    return { time: undefined, endX: startX };
  }

  const endX = Math.max(upper.component.x1, lower.component.x1) + Math.round(u * 0.5);
  return { time: { beats, beatType }, endX };
}

// ─── Pitch mapping ─────────────────────────────────────────────────────────────

const DIATONIC_NAMES = ["C", "D", "E", "F", "G", "A", "B"] as const;

/**
 * Absolute diatonic value of the top staff line for each supported clef.
 * Value = octave × 7 + noteIndex (C=0, D=1, …, B=6).
 *
 *   Treble (G2): top line = F5 = 5×7+3 = 38
 *   Bass   (F4): top line = A3 = 3×7+5 = 26
 */
const TOP_LINE_DIATONIC: Record<string, number> = {
  G: 38,
  F: 26,
};

/**
 * Convert an absolute diatonic value to a pitch string like "F5" or "C4".
 * Handles negative diatonic values correctly via floored division.
 */
function diatonicToPitch(value: number): string {
  const mod = ((value % 7) + 7) % 7;
  const octave = Math.floor(value / 7);
  return `${DIATONIC_NAMES[mod]}${octave}`;
}

/**
 * Compute the pitch corresponding to a y-coordinate in the cropped staff
 * image. `lineYsInCrop[0]` is the top staff line; each diatonic step is
 * `unitSize / 2` pixels.
 */
function yToPitch(
  y: number,
  lineYsInCrop: number[],
  unitSize: number,
  clefSign: string,
): string {
  const steps = Math.round((y - lineYsInCrop[0]) / (unitSize / 2));
  const referenceDiatonic = TOP_LINE_DIATONIC[clefSign] ?? TOP_LINE_DIATONIC.G;
  return diatonicToPitch(referenceDiatonic - steps);
}

// ─── Duration determination ───────────────────────────────────────────────────

type DurationValue = NoteEvent["duration"];

/**
 * Determine the duration of a note whose connected component is `comp`.
 *
 * Strategy:
 *   1. Compute the local density around the notehead row.
 *      Low density (<0.45) → open notehead (half or whole).
 *      High density (>0.52) → filled notehead (quarter or shorter).
 *   2. An open notehead with no stem (component height < 1.5u) → whole note.
 *   3. For filled noteheads, check for an overlapping beam component:
 *      a beam whose x-range covers this notehead's center makes it at least
 *      an eighth note. The total vertical extent of the overlapping beam
 *      region approximates the beam count.
 */
function determineDuration(
  comp: Component,
  ink: Uint8Array,
  imageWidth: number,
  beamComponents: Component[],
  unitSize: number,
): DurationValue {
  const u = unitSize;
  const nhRow = notePitchRow(ink, comp, imageWidth);
  const isOpen = isOpenNoteheadShape(ink, comp, imageWidth, nhRow, u);
  const h = compHeight(comp);

  if (isOpen) {
    // Whole note: open oval with no stem (component is just the notehead)
    if (h < 1.5 * u) return "whole";
    return "half";
  }

  // Filled notehead: quarter or shorter. Check for a beam.
  const nhCenterX = (comp.x0 + comp.x1) / 2;
  const xTolerance = u * 0.7;

  // Beams that horizontally overlap this note's x-center and are at least
  // 1.5u away from the notehead row (near the stem tip, not the notehead).
  const overlapping = beamComponents.filter(
    (b) =>
      b.x0 <= nhCenterX + xTolerance &&
      b.x1 >= nhCenterX - xTolerance &&
      (b.y1 < nhRow - 1.5 * u || b.y0 > nhRow + 1.5 * u),
  );

  if (overlapping.length === 0) {
    // No beam: check for a flag (isolated eighth). A flag makes the component
    // taller than a plain quarter note (stem + flag ≈ 5.5u vs. stem ≈ 4u).
    return h > 5.0 * u ? "eighth" : "quarter";
  }

  // Beam present: count beams from total vertical extent of overlapping beams.
  const beamTop = Math.min(...overlapping.map((b) => b.y0));
  const beamBottom = Math.max(...overlapping.map((b) => b.y1));
  const beamExtent = beamBottom - beamTop;

  if (beamExtent < 0.8 * u) return "eighth";
  if (beamExtent < 1.4 * u) return "sixteenth";
  return "thirty_second";
}

// ─── Note reading ─────────────────────────────────────────────────────────────

/** Count how many values in a sorted array are strictly less than `x`. */
function countLess(sorted: number[], x: number): number {
  let count = 0;
  for (const v of sorted) {
    if (v < x) count++;
  }
  return count;
}

/**
 * Convert a NoteEvent duration to a kern-style rhythm token string for the
 * `rawRhythm` debug field.
 */
function durationToKern(duration: DurationValue, dotted: boolean): string {
  const kernMap: Record<DurationValue, string> = {
    whole: "1",
    half: "2",
    quarter: "4",
    eighth: "8",
    sixteenth: "16",
    thirty_second: "32",
  };
  return `note_${kernMap[duration]}${dotted ? "." : ""}`;
}

/**
 * Build the full list of NoteEvents from the classified symbols. Processes
 * noteheads, rest blocks, and determines pitch, duration, dotted, chord,
 * accidental, and measure index for each.
 */
function readNotes(
  symbols: ClassifiedSymbol[],
  ink: Uint8Array,
  imageWidth: number,
  lineYsInCrop: number[],
  unitSize: number,
  clefSign: string,
  noteStartX: number,
): NoteEvent[] {
  const u = unitSize;

  const barlineXs = symbols
    .filter((s) => s.kind === "barline" && centroidX(s.component) > noteStartX)
    .map((s) => centroidX(s.component))
    .sort((a, b) => a - b);

  const beamComps = symbols
    .filter((s) => s.kind === "beam")
    .map((s) => s.component);

  const dotSymbols = symbols.filter(
    (s) => s.kind === "dot" && centroidX(s.component) > noteStartX,
  );

  const accidentalSymbols = symbols.filter(
    (s) =>
      (s.kind === "sharp" || s.kind === "flat") &&
      centroidX(s.component) > noteStartX,
  );

  // ── Rests ─────────────────────────────────────────────────────────────────
  const restNotes: NoteEvent[] = symbols
    .filter((s) => s.kind === "rest-block" && centroidX(s.component) > noteStartX)
    .map((s) => {
      const cx = centroidX(s.component);
      const cy = centroidY(s.component);
      const measureIndex = countLess(barlineXs, cx);
      const midY = (lineYsInCrop[0] + lineYsInCrop[4]) / 2;
      // Whole rest hangs below line 1 (upper); half rest sits on line 2 (lower).
      const duration: DurationValue = cy < midY ? "whole" : "half";
      return {
        pitch: "rest" as const,
        accidental: null,
        duration,
        dotted: false,
        measureIndex,
        chord: false,
      };
    });

  // ── Noteheads ─────────────────────────────────────────────────────────────
  const noteheadSymbols = symbols
    .filter(
      (s) =>
        (s.kind === "notehead-filled" || s.kind === "notehead-open") &&
        centroidX(s.component) > noteStartX,
    )
    .sort((a, b) => centroidX(a.component) - centroidX(b.component));

  const noteNotes: NoteEvent[] = noteheadSymbols.map((s, index) => {
    const comp = s.component;
    const nhRow = notePitchRow(ink, comp, imageWidth);
    const nhCenterX = (comp.x0 + comp.x1) / 2;

    const pitch = yToPitch(nhRow, lineYsInCrop, u, clefSign);
    const duration = determineDuration(comp, ink, imageWidth, beamComps, u);
    const isDotted = dotSymbols.some(
      (d) =>
        centroidX(d.component) > nhCenterX + u * 0.25 &&
        centroidX(d.component) < nhCenterX + u * 2.0 &&
        Math.abs(centroidY(d.component) - nhRow) < u * 0.6,
    );

    // Nearest accidental directly to the left of this notehead.
    const nearAccidentals = accidentalSymbols.filter(
      (a) =>
        centroidX(a.component) < nhCenterX - u * 0.1 &&
        centroidX(a.component) > nhCenterX - u * 3.0 &&
        Math.abs(centroidY(a.component) - nhRow) < u * 1.5,
    );
    nearAccidentals.sort(
      (a, b) => centroidX(b.component) - centroidX(a.component),
    );
    const nearAcc = nearAccidentals[0];
    const accidental: NoteEvent["accidental"] =
      nearAcc?.kind === "sharp"
        ? "sharp"
        : nearAcc?.kind === "flat"
          ? "flat"
          : null;

    // Chord: x-position is very close to the previous notehead
    const prevSymbol = index > 0 ? noteheadSymbols[index - 1] : undefined;
    const chord =
      prevSymbol !== undefined &&
      Math.abs(nhCenterX - (prevSymbol.component.x0 + prevSymbol.component.x1) / 2) <
        u * 0.7;

    const measureIndex = countLess(barlineXs, nhCenterX);

    return {
      pitch,
      accidental,
      duration,
      dotted: isDotted,
      measureIndex,
      chord,
    };
  });

  // Sort all events by x-position and measure.
  return [...restNotes, ...noteNotes].sort((a, b) => {
    if (a.measureIndex !== b.measureIndex) return a.measureIndex - b.measureIndex;
    // Within a measure, use the original order (already sorted by x).
    return 0;
  });
}

// ─── Per-staff transcription ──────────────────────────────────────────────────

function transcribeStaffClassically(image: RgbaImage, staff: Staff): Transcription {
  const u = staff.unitSize;

  // Crop the staff with 2.5u padding (same as TrOMR's cropStaff).
  const cropped = cropStaff(image, staff);
  const padding = Math.round(u * 2.5);
  const cropTop = Math.max(0, Math.floor(staff.lines[0]) - padding);
  // Staff line positions in the crop's coordinate system.
  const lineYsInCrop = staff.lines.map((line) => line - cropTop);

  const rawInk = binarize(cropped);
  const ink = removeStaffLinesAndClose(rawInk, cropped.width, cropped.height, lineYsInCrop);
  // Remove beams before CC labeling so they don't merge with the noteheads and
  // stems they connect. The extracted beam CCs are added back as "beam" symbols.
  const { inkWithoutBeams, beamComponents } = suppressBeams(ink, cropped.width, cropped.height, u);
  // Re-close after beam suppression: thick staff lines (≥4 px) leave a residual
  // row after ±1 erasure; the closing above bridges the 3-row gap but the
  // residual row is full-page-width and gets suppressed as a beam. That creates
  // a fresh 1-row gap in tall symbols (clef, stems). A second closing with the
  // same radius re-bridges those gaps without merging symbols that are a staff
  // space apart (the space >> 2×radius at any realistic unit size).
  const inkClosed = verticalClose(inkWithoutBeams, cropped.width, cropped.height, 2);
  const components = labelComponents(inkClosed, cropped.width, cropped.height);

  const baseSymbols = classifyAll(components, inkClosed, cropped.width, lineYsInCrop, u);
  const beamSymbols: ClassifiedSymbol[] = beamComponents.map((c) => ({
    component: c,
    kind: "beam" as SymbolKind,
  }));
  const symbols = [...baseSymbols, ...beamSymbols];

  // ── Header: clef → key → time ─────────────────────────────────────────────
  const { clef, endX: clefEndX } = detectClef(symbols, lineYsInCrop, u);
  const { keyFifths, endX: keyEndX } = detectKeySignature(symbols, clefEndX, u);
  const { time, endX: timeEndX } = detectTimeSignature(
    symbols,
    keyEndX,
    u,
    inkClosed,
    cropped.width,
  );

  const noteStartX = timeEndX + Math.round(u * 0.3);

  const attributes: ScoreAttributes = {
    ...(clef !== undefined && { clef }),
    ...(keyFifths !== 0 && { keyFifths }),
    ...(time !== undefined && { time }),
  };

  const clefSign = clef?.sign ?? "G";

  // ── Note reading ──────────────────────────────────────────────────────────
  const notes = readNotes(
    symbols,
    inkClosed,
    cropped.width,
    lineYsInCrop,
    u,
    clefSign,
    noteStartX,
  );

  const measureCount =
    notes.length === 0 ? 0 : notes[notes.length - 1].measureIndex + 1;

  // Build a human-readable rhythm token list for the debug panel.
  const barlineXs = symbols
    .filter((s) => s.kind === "barline" && centroidX(s.component) > noteStartX)
    .map((s) => centroidX(s.component))
    .sort((a, b) => a - b);

  const rawRhythm: string[] = [];
  if (clef !== undefined) rawRhythm.push(`clef_${clef.sign}${clef.line}`);
  if (keyFifths !== 0) rawRhythm.push(`keySignature_${keyFifths}`);
  if (time !== undefined) {
    rawRhythm.push(`timeSignature/${time.beats}`, `timeSignature/${time.beatType}`);
  }
  let lastMeasure = -1;
  for (const note of notes) {
    if (note.measureIndex > lastMeasure && lastMeasure >= 0) rawRhythm.push("barline");
    lastMeasure = note.measureIndex;
    if (note.chord) rawRhythm.push("chord");
    if (note.pitch === "rest") {
      rawRhythm.push(`rest_${note.duration === "whole" ? "1" : "2"}${note.dotted ? "." : ""}`);
    } else {
      rawRhythm.push(durationToKern(note.duration, note.dotted));
    }
  }
  // Append any trailing barlines (empty measures at end).
  const lastNoteX = notes.length > 0
    ? (() => {
        // We need the actual x-position; approximate from measure index.
        const lastMeasureIdx = notes[notes.length - 1].measureIndex;
        return barlineXs[lastMeasureIdx] ?? 0;
      })()
    : 0;

  console.info(
    `[omr] classical staff: clef=${clef?.sign ?? "?"}${clef?.line ?? "?"} ` +
      `key=${keyFifths} time=${time ? `${time.beats}/${time.beatType}` : "?"} ` +
      `notes=${notes.length} measures=${measureCount}`,
  );

  return { notes, measureCount, rawRhythm, attributes };
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Transcribe every detected staff in `staves` using classical image analysis
 * (no ONNX models). Returns one {@link Transcription} per staff, in the same
 * order as `staves`. This is a drop-in synchronous replacement for
 * {@link transcribeStaves} on the TrOMR path.
 */
export function transcribeStavesClassically(
  image: RgbaImage,
  staves: Staff[],
  options: TranscribeOptions = {},
): Transcription[] {
  return staves.map((staff, index) => {
    const result = transcribeStaffClassically(image, staff);
    options.onProgress?.(index + 1, staves.length);
    return result;
  });
}
