/**
 * Recovers the leading score attributes — clef, key signature, time signature —
 * from a staff's TrOMR rhythm token stream.
 *
 * These symbols precede the staff's first note. The decoder (`decode-tokens.ts`)
 * skips them so it can focus on note/rest events; this pass reads them so the
 * MusicXML builder can emit real opening attributes instead of hardcoded
 * treble / C major / 4/4.
 *
 * Token forms (see `vocabulary.ts`):
 *   - `clef_G2`, `clef_F4`, `clef_C3` — sign letter + staff line.
 *   - `keySignature_-2`, `keySignature_3` — fifths count (− flats, + sharps).
 *   - `timeSignature/N` — a *single* number. A time signature is two of these in
 *     a row: numerator then denominator (4/4 → `timeSignature/4`,
 *     `timeSignature/4`; 6/8 → `timeSignature/6`, `timeSignature/8`). The
 *     vocabulary's value set mixes typical numerators and denominators, which is
 *     why a pair is needed to pin down the meter.
 *
 * Only the *opening* attributes are captured: scanning stops at the first note,
 * rest, or barline, so a mid-staff clef or key change is left for later phases.
 */
import type { ScoreAttributes } from "../types";
import { RHYTHM_VOCAB } from "./vocabulary";

function parseClef(token: string): ScoreAttributes["clef"] | null {
  const body = token.slice("clef_".length); // e.g. "G2"
  const sign = body[0];
  const line = Number(body.slice(1));
  if ((sign === "G" || sign === "F" || sign === "C") && Number.isInteger(line)) {
    return { sign, line };
  }
  return null;
}

export function decodeAttributes(
  rhythmIds: ArrayLike<number>,
): ScoreAttributes {
  const attributes: ScoreAttributes = {};
  // Time signatures arrive as a numerator/denominator pair of `timeSignature/N`
  // tokens; collect the leading run and resolve it once scanning finishes.
  const timeNumbers: number[] = [];

  for (let index = 0; index < rhythmIds.length; index++) {
    const token = RHYTHM_VOCAB[rhythmIds[index]] ?? "";

    if (token === "EOS" || token === "PAD") {
      break;
    }
    if (token === "BOS") {
      continue;
    }
    // The first musical event ends the opening-attributes region.
    if (token.startsWith("note_") || token.startsWith("rest_")) {
      break;
    }

    if (token.startsWith("clef_")) {
      // Keep the first clef; a later one would be a mid-staff change.
      if (attributes.clef === undefined) {
        const clef = parseClef(token);
        if (clef !== null) {
          attributes.clef = clef;
        }
      }
    } else if (token.startsWith("keySignature_")) {
      if (attributes.keyFifths === undefined) {
        const fifths = Number(token.slice("keySignature_".length));
        if (Number.isInteger(fifths)) {
          attributes.keyFifths = fifths;
        }
      }
    } else if (token.startsWith("timeSignature/")) {
      const number = Number(token.slice("timeSignature/".length));
      if (Number.isInteger(number)) {
        timeNumbers.push(number);
      }
    }
    // Other leading tokens (volta brackets, etc.) are ignored.
  }

  // A well-formed time signature is exactly one numerator/denominator pair.
  // Anything else is ambiguous, so leave it unset and let the builder default.
  if (timeNumbers.length === 2) {
    attributes.time = { beats: timeNumbers[0], beatType: timeNumbers[1] };
  }

  return attributes;
}
