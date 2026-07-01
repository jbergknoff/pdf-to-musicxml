/**
 * Drives the TrOMR encoder-decoder ONNX models over one cropped staff image,
 * producing the three raw token-ID sequences (rhythm, pitch, lift).
 *
 * Architecture (Polyphonic-TrOMR / homr):
 *   Encoder: ConvNeXt image → context features [1, seq_len, 512]
 *   Decoder: autoregressive transformer with KV cache (32 cache tensors per
 *     step: 8 layers × 4 KV pairs). Runs until the rhythm head predicts EOS
 *     or maxDecodingSteps is reached.
 *
 * Pure inference — no vocabulary decoding here (see decode-tokens.ts).
 */
import type { InferenceSession, Tensor } from "../runtime/inference-backend";
import type { RgbaImage, Staff } from "../types";
import { TROMR_CONSTANTS } from "../models/manifest";
import { cropStaff, prepareStaffTensor } from "./staff-crop";
import { BOS, EOS, NONOTE } from "./vocabulary";

export interface TrOMRSessions {
  encoder: InferenceSession;
  /**
   * The decoder session. Always created on the WASM execution provider (see
   * src/models/registry.ts): its fused SkipLayerNormalization op does not run
   * on ORT's WebGPU EP, and its tiny autoregressive steps are faster on WASM.
   */
  decoder: InferenceSession;
}

/** Find the argmax over data[offset .. offset+size). */
function argmax(data: Float32Array, offset: number, size: number): number {
  let best = 0;
  let bestVal = data[offset];
  for (let i = 1; i < size; i++) {
    const v = data[offset + i];
    if (v > bestVal) {
      bestVal = v;
      best = i;
    }
  }
  return best;
}

/**
 * Run the TrOMR encoder on one staff image.
 * Returns the context tensor as Float32Array plus the encoder sequence length.
 */
async function runEncoder(
  encoderSession: InferenceSession,
  image: RgbaImage,
  staff: Staff,
): Promise<{ context: Float32Array; seqLen: number }> {
  const cropped = cropStaff(image, staff);
  const { data, width } = prepareStaffTensor(
    cropped,
    TROMR_CONSTANTS.inputHeight,
    TROMR_CONSTANTS.inputWidth,
  );

  const inputName = encoderSession.inputNames[0];
  const feeds: Record<string, Tensor> = {
    [inputName]: {
      type: "float32",
      data,
      dims: [1, 1, TROMR_CONSTANTS.inputHeight, width],
    },
  };

  const outputs = await encoderSession.run(feeds);
  const contextTensor = Object.values(outputs)[0];
  const context = contextTensor.data as Float32Array;
  // Context shape: [1, seq_len, 512]. Recover seq_len from the total size.
  const seqLen = context.length / 512;
  console.info(
    `[omr] encoder context: seqLen=${seqLen} (${context.length} floats)`,
  );
  return { context, seqLen };
}

/**
 * Run the TrOMR decoder autoregressively until EOS in the rhythm head.
 * Returns the predicted token IDs for rhythm, pitch, lift, and slur (excluding
 * the initial BOS inputs, up to but not including EOS). The slur head marks
 * curved-line spans (phrase slurs and ties alike — see vocabulary.ts); it is
 * fed back into the decoder every step regardless, but is now also recorded
 * per note so the builder can recover ties (see decode-tokens.ts).
 */
async function runDecoder(
  decoderSession: InferenceSession,
  context: Float32Array,
  seqLen: number,
): Promise<{
  rhythm: number[];
  pitch: number[];
  lift: number[];
  slur: number[];
}> {
  const { numCacheTensors, numHeads, headDim, maxDecodingSteps } =
    TROMR_CONSTANTS;

  const rhythmOut: number[] = [];
  const pitchOut: number[] = [];
  const liftOut: number[] = [];
  const slurOut: number[] = [];

  // Start all heads with their respective "beginning" tokens.
  // Rhythm uses BOS (index 1); pitch and lift use NONOTE (index 0, the "."
  // nonote token that signals no content on a non-note symbol).
  let rhythmToken = BOS;
  let pitchToken = NONOTE;
  let liftToken = NONOTE;
  // Articulation is not used for Phase 3 output but must be fed because it is
  // a decoder input.
  let articulationToken = NONOTE;
  let slurToken = NONOTE;

  // The KV caches start empty (seqLen=0): step 0 has no past entries. The
  // decoder runs on WASM, which accepts a true zero-element tensor.
  const cacheSeqLens: number[] = new Array(numCacheTensors).fill(0);
  const caches: Float32Array[] = Array.from(
    { length: numCacheTensors },
    () => new Float32Array(0),
  );

  // After step 0 the cross-attention K/V values for all encoder tokens are
  // stored in cache_in (4 of the 32 KV tensors per layer are cross-attention).
  // Subsequent steps only need a single placeholder token to satisfy the input
  // shape; the cached cross-attention handles the rest. This avoids copying
  // seqLen×512 floats into WASM on every one of the 256 decoding steps.
  const firstContextToken = context.slice(0, 512);

  for (let step = 0; step < maxDecodingSteps; step++) {
    const isFirstStep = step === 0;
    const contextData = isFirstStep ? context : firstContextToken;
    const contextSeqLen = isFirstStep ? seqLen : 1;

    const feeds: Record<string, Tensor> = {
      rhythms: {
        type: "int64",
        data: new BigInt64Array([BigInt(rhythmToken)]),
        dims: [1, 1],
      },
      pitchs: {
        type: "int64",
        data: new BigInt64Array([BigInt(pitchToken)]),
        dims: [1, 1],
      },
      lifts: {
        type: "int64",
        data: new BigInt64Array([BigInt(liftToken)]),
        dims: [1, 1],
      },
      articulations: {
        type: "int64",
        data: new BigInt64Array([BigInt(articulationToken)]),
        dims: [1, 1],
      },
      slurs: {
        type: "int64",
        data: new BigInt64Array([BigInt(slurToken)]),
        dims: [1, 1],
      },
      context: {
        type: "float32",
        data: contextData,
        dims: [1, contextSeqLen, 512],
      },
      cache_len: {
        type: "int64",
        data: new BigInt64Array([BigInt(step)]),
        dims: [1],
      },
    };

    for (let i = 0; i < numCacheTensors; i++) {
      feeds[`cache_in${i}`] = {
        type: "float32",
        data: caches[i],
        dims: [1, numHeads, cacheSeqLens[i], headDim],
      };
    }

    const outputs = await decoderSession.run(feeds);

    // Logits: out_rhythms / out_pitchs / out_lifts / out_slurs shape
    // [1, 1, vocab_size]. Take the last (only) position's argmax.
    const rhythmLogits = outputs.out_rhythms?.data as Float32Array;
    const pitchLogits = outputs.out_pitchs?.data as Float32Array;
    const liftLogits = outputs.out_lifts?.data as Float32Array;
    const articulationLogits = outputs.out_articulations?.data as
      | Float32Array
      | undefined;
    const slurLogits = outputs.out_slurs?.data as Float32Array | undefined;

    if (rhythmLogits === undefined) {
      throw new Error("TrOMR decoder: missing out_rhythms output");
    }

    const rhythmVocabSize = rhythmLogits.length; // [1, 1, V] → V
    const pitchVocabSize = pitchLogits?.length ?? 1;
    const liftVocabSize = liftLogits?.length ?? 1;

    const nextRhythm = argmax(rhythmLogits, 0, rhythmVocabSize);
    const nextPitch =
      pitchLogits !== undefined
        ? argmax(pitchLogits, 0, pitchVocabSize)
        : NONOTE;
    const nextLift =
      liftLogits !== undefined ? argmax(liftLogits, 0, liftVocabSize) : NONOTE;
    const nextArticulation =
      articulationLogits !== undefined
        ? argmax(articulationLogits, 0, articulationLogits.length)
        : NONOTE;
    const nextSlur =
      slurLogits !== undefined
        ? argmax(slurLogits, 0, slurLogits.length)
        : NONOTE;

    // Stop when the rhythm head predicts EOS.
    if (nextRhythm === EOS) {
      break;
    }

    rhythmOut.push(nextRhythm);
    pitchOut.push(nextPitch);
    liftOut.push(nextLift);
    slurOut.push(nextSlur);

    rhythmToken = nextRhythm;
    pitchToken = nextPitch;
    liftToken = nextLift;
    articulationToken = nextArticulation;
    slurToken = nextSlur;

    // Advance KV caches: each cache_out grows by 1 in the seq dimension.
    for (let i = 0; i < numCacheTensors; i++) {
      const cacheOut = outputs[`cache_out${i}`]?.data as
        | Float32Array
        | undefined;
      if (cacheOut !== undefined) {
        caches[i] = cacheOut;
        cacheSeqLens[i] = cacheOut.length / (numHeads * headDim);
      }
    }
  }

  return { rhythm: rhythmOut, pitch: pitchOut, lift: liftOut, slur: slurOut };
}

/**
 * Run TrOMR on one detected staff: encode the image crop, then decode
 * autoregressively. Returns the four raw token-ID sequences.
 */
export async function runTrOMR(
  sessions: TrOMRSessions,
  image: RgbaImage,
  staff: Staff,
): Promise<{
  rhythm: number[];
  pitch: number[];
  lift: number[];
  slur: number[];
}> {
  const { context, seqLen } = await runEncoder(sessions.encoder, image, staff);
  return runDecoder(sessions.decoder, context, seqLen);
}
