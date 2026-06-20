/**
 * Recovers score attributes — clef, key signature, time signature — from a
 * staff's TrOMR rhythm token stream.
 *
 * The *opening* attributes precede the staff's first note; `decodeAttributes`
 * reads them so the MusicXML builder can emit real opening `<attributes>`
 * instead of hardcoded treble / C major / 4/4. The same per-token parsers are
 * reused by `decode-tokens.ts` to attach *mid-staff* attribute changes (a later
 * clef or key change) to the note they precede.
 *
 * Token forms (see `vocabulary.ts`):
 *   - `clef_G2`, `clef_F4`, `clef_C3` — sign letter + staff line.
 *   - `keySignature_-2`, `keySignature_3` — fifths count (− flats, + sharps).
 *   - `timeSignature/N` — a *single* number. A time signature is two of these in
 *     a row: numerator then denominator (4/4 → `timeSignature/4`,
 *     `timeSignature/4`; 6/8 → `timeSignature/6`, `timeSignature/8`). The
 *     vocabulary's value set mixes typical numerators and denominators, which is
 *     why a pair is needed to pin down the meter.
 */
import type { ScoreAttributes } from "../types";
import { RHYTHM_VOCAB } from "./vocabulary";

/** Parse a `clef_G2`-style token into its sign and staff line, or null. */
export function parseClefToken(token: string): ScoreAttributes["clef"] | null {
  const body = token.slice("clef_".length); // e.g. "G2"
  const sign = body[0];
  const line = Number(body.slice(1));
  if ((sign === "G" || sign === "F" || sign === "C") && Number.isInteger(line)) {
    return { sign, line };
  }
  return null;
}

/** Parse a `keySignature_-2`-style token into a fifths count, or null. */
export function parseKeyToken(token: string): number | null {
  const fifths = Number(token.slice("keySignature_".length));
  return Number.isInteger(fifths) ? fifths : null;
}

/** Parse one `timeSignature/N` token into its number, or null. */
export function parseTimeToken(token: string): number | null {
  const number = Number(token.slice("timeSignature/".length));
  return Number.isInteger(number) ? number : null;
}

/**
 * Resolve a run of `timeSignature/N` numbers into a meter. A well-formed time
 * signature is exactly one numerator/denominator pair; anything else is
 * ambiguous, so return undefined and let the caller default.
 */
export function resolveTime(numbers: number[]): ScoreAttributes["time"] {
  if (numbers.length === 2) {
    return { beats: numbers[0], beatType: numbers[1] };
  }
  return undefined;
}

/**
 * Read the leading clef/key/time attributes that precede a staff's first note.
 * Scanning stops at the first note, rest, or barline, so only the opening
 * attributes are captured; mid-staff changes are handled in `decode-tokens.ts`.
 */
export function decodeAttributes(rhythmIds: ArrayLike<number>): ScoreAttributes {
  const attributes: ScoreAttributes = {};
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
        const clef = parseClefToken(token);
        if (clef !== null) {
          attributes.clef = clef;
        }
      }
    } else if (token.startsWith("keySignature_")) {
      if (attributes.keyFifths === undefined) {
        const fifths = parseKeyToken(token);
        if (fifths !== null) {
          attributes.keyFifths = fifths;
        }
      }
    } else if (token.startsWith("timeSignature/")) {
      const number = parseTimeToken(token);
      if (number !== null) {
        timeNumbers.push(number);
      }
    }
    // Other leading tokens (volta brackets, etc.) are ignored.
  }

  const time = resolveTime(timeNumbers);
  if (time !== undefined) {
    attributes.time = time;
  }
  return attributes;
}
