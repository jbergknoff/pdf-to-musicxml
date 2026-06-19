import { describe, expect, it } from "bun:test";
import {
  blobKeyFromPath,
  MODEL_ENTRIES,
  MODEL_MANIFEST,
  MODEL_VERSION,
  modelUrl,
} from "./manifest";

describe("model manifest", () => {
  it("versions each file name and keeps url/key in lockstep", () => {
    const entry = MODEL_MANIFEST.staffSymbol;
    expect(entry.fileName).toContain(MODEL_VERSION);
    expect(entry.fileName.endsWith(".onnx")).toBe(true);
    expect(modelUrl(entry)).toBe(`/models/${entry.fileName}`);
    // The served URL's key round-trips back to the blob key (the file name).
    expect(blobKeyFromPath(modelUrl(entry))).toBe(entry.fileName);
  });

  it("exposes all models", () => {
    expect(MODEL_ENTRIES.map((entry) => entry.id).sort()).toEqual([
      "staffSymbol",
      "symbolDetail",
      "tromrDecoder",
      "tromrEncoder",
    ]);
  });
});

describe("blobKeyFromPath", () => {
  it("returns the flat key for a model path", () => {
    expect(blobKeyFromPath("/models/1st_model.v1.onnx")).toBe(
      "1st_model.v1.onnx",
    );
  });

  it("rejects non-model and unsafe paths", () => {
    expect(blobKeyFromPath("/assets/app.js")).toBeNull();
    expect(blobKeyFromPath("/models/")).toBeNull();
    expect(blobKeyFromPath("/models/sub/dir.onnx")).toBeNull();
    expect(blobKeyFromPath("/models/..")).toBeNull();
  });
});
