/**
 * Orchestrates Phase 3 transcription: for each detected staff, crop the strip,
 * run TrOMR (encoder + autoregressive decoder), decode the tokens, and collect
 * all note events.
 */
import type { RgbaImage, Staff, Transcription } from "../types";
import { decodeAttributes } from "./decode-attributes";
import { decodeTokens } from "./decode-tokens";
import type { TrOMRSessions } from "./tromr-session";
import { runTrOMR } from "./tromr-session";
import { RHYTHM_VOCAB } from "./vocabulary";

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
    results.push({ notes, measureCount, rawRhythm, attributes });
    options.onProgress?.(index + 1, staves.length);
  }
  return results;
}
