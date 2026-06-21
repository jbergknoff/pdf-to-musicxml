/**
 * Orchestrates Phase 3 transcription: for each detected staff, crop the strip,
 * run TrOMR (encoder + autoregressive decoder), decode the tokens, and collect
 * all note events.
 */
import type { ScoreAttributes, RgbaImage, Staff, Transcription } from "../types";
import { decodeAttributes } from "./decode-attributes";
import { decodeTokens } from "./decode-tokens";
import type { TrOMRSessions } from "./tromr-session";
import { runTrOMR } from "./tromr-session";
import { LIFT_VOCAB, PITCH_VOCAB, RHYTHM_VOCAB } from "./vocabulary";

/** Map token IDs to their vocabulary strings (unknown ids shown as `?<id>`). */
function tokensToText(ids: ArrayLike<number>, vocab: readonly string[]): string {
  return Array.from(ids, (id) => vocab[id] ?? `?${id}`).join(" ");
}

/** A compact, human-readable summary of the attributes decoded for a staff. */
function describeAttributes(attributes: ScoreAttributes): string {
  const clef =
    attributes.clef !== undefined
      ? `${attributes.clef.sign}${attributes.clef.line}`
      : "(none)";
  const key = attributes.keyFifths ?? "(none)";
  const time =
    attributes.time !== undefined
      ? `${attributes.time.beats}/${attributes.time.beatType}`
      : "(none)";
  return `clef=${clef} key=${key} time=${time}`;
}

export interface TranscribeOptions {
  /** Called after each staff is processed, for progress reporting. */
  onProgress?: (staffIndex: number, total: number) => void;
}

/**
 * Transcribe every detected staff in `staves` using the TrOMR encoder and
 * decoder sessions. Returns one `Transcription` per staff, in the same order
 * as `staves`.
 */
export async function transcribeStaves(
  sessions: TrOMRSessions,
  image: RgbaImage,
  staves: Staff[],
  options: TranscribeOptions = {},
): Promise<Transcription[]> {
  const results: Transcription[] = [];
  for (let index = 0; index < staves.length; index++) {
    const tokens = await runTrOMR(sessions, image, staves[index]);
    const notes = decodeTokens(tokens.rhythm, tokens.pitch, tokens.lift);
    const attributes = decodeAttributes(tokens.rhythm);
    const measureCount =
      notes.length === 0 ? 0 : notes[notes.length - 1].measureIndex + 1;
    const rawRhythm = tokens.rhythm.map((id) => RHYTHM_VOCAB[id] ?? `?${id}`);

    // Copious per-staff TrOMR logging: the three raw token streams plus what we
    // decoded from them. The decoded clef/key/time is the first thing to check
    // when assembly errors out on a missing clef or renders the wrong one.
    const label = `[omr] staff ${index + 1}/${staves.length}`;
    console.info(
      `${label} TrOMR tokens (${tokens.rhythm.length}):\n` +
        `  rhythm: ${tokensToText(tokens.rhythm, RHYTHM_VOCAB)}\n` +
        `  pitch:  ${tokensToText(tokens.pitch, PITCH_VOCAB)}\n` +
        `  lift:   ${tokensToText(tokens.lift, LIFT_VOCAB)}`,
    );
    console.info(
      `${label} decoded: ${describeAttributes(attributes)} ` +
        `notes=${notes.length} measures=${measureCount}`,
    );

    results.push({ notes, measureCount, rawRhythm, attributes });
    options.onProgress?.(index + 1, staves.length);
  }
  return results;
}
