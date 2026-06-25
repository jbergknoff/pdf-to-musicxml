import { describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import {
  addNote,
  createBlankDocument,
  type NoteHandle,
  parseDocument,
  removeNote,
  serializeDocument,
} from "./dom-edit";
import { isRest, parseScore } from "./sheet-music/index";
import { type History, useHistory } from "./use-history";

// Mount the hook in a throwaway component and expose its latest return value.
function mountHistory(): () => History {
  let latest!: History;
  function Probe() {
    latest = useHistory(() => createBlankDocument());
    return null;
  }
  const container = document.createElement("div");
  act(() => {
    render(h(Probe, null), container as unknown as Element);
  });
  return () => latest;
}

// Count the real (non-rest) notes in the live document.
function noteCount(doc: Document): number {
  const score = parseScore(serializeDocument(doc));
  let count = 0;
  for (const measure of score.parts[0].measures) {
    for (const event of measure.events) {
      if (!isRest(event)) {
        count += 1;
      }
    }
  }
  return count;
}

function addC5(doc: Document, onset: number): NoteHandle {
  return addNote(doc, {
    measureIndex: 0,
    onsetBeatInMeasure: onset,
    durationBeats: 1,
    pitch: { step: "C", alter: 0, octave: 5 },
  }) as NoteHandle;
}

describe("useHistory", () => {
  test("undo and redo restore document content", () => {
    const get = mountHistory();
    expect(get().canUndo).toBe(false);
    expect(noteCount(get().documentRef.current)).toBe(0);

    act(() => {
      addC5(get().documentRef.current, 0);
      get().commit();
    });
    expect(noteCount(get().documentRef.current)).toBe(1);
    expect(get().canUndo).toBe(true);
    expect(get().canRedo).toBe(false);

    act(() => get().undo());
    expect(noteCount(get().documentRef.current)).toBe(0);
    expect(get().canUndo).toBe(false);
    expect(get().canRedo).toBe(true);

    act(() => get().redo());
    expect(noteCount(get().documentRef.current)).toBe(1);
    expect(get().canRedo).toBe(false);
  });

  test("a new edit clears the redo stack", () => {
    const get = mountHistory();
    act(() => {
      addC5(get().documentRef.current, 0);
      get().commit();
    });
    act(() => get().undo());
    expect(get().canRedo).toBe(true);
    act(() => {
      addC5(get().documentRef.current, 2);
      get().commit();
    });
    expect(get().canRedo).toBe(false);
    expect(noteCount(get().documentRef.current)).toBe(1);
  });

  test("coalesced commits collapse into a single undo entry", () => {
    const get = mountHistory();
    // Three nudge-style commits sharing a coalesce key: one undo reverts them.
    act(() => {
      const handle = addC5(get().documentRef.current, 0);
      get().commit();
      // Now three quick same-key edits.
      removeNote(get().documentRef.current, handle);
      addC5(get().documentRef.current, 1);
      get().commit({ coalesce: "nudge" });
    });
    act(() => {
      addC5(get().documentRef.current, 2);
      get().commit({ coalesce: "nudge" });
    });
    // Two notes now (beat 1 and beat 2).
    expect(noteCount(get().documentRef.current)).toBe(2);
    // One undo reverts the whole coalesced run back to the single beat-0 note.
    act(() => get().undo());
    expect(noteCount(get().documentRef.current)).toBe(1);
  });

  test("dirty baseline tracks load and save", () => {
    const get = mountHistory();
    const baseline = get().baselineXml;
    expect(serializeDocument(get().documentRef.current)).toBe(baseline);

    act(() => {
      addC5(get().documentRef.current, 0);
      get().commit();
    });
    // The document now differs from the baseline (dirty).
    expect(serializeDocument(get().documentRef.current)).not.toBe(
      get().baselineXml,
    );

    // markSaved re-baselines to the current document (no longer dirty).
    act(() => get().markSaved());
    expect(serializeDocument(get().documentRef.current)).toBe(
      get().baselineXml,
    );
  });

  test("reset loads a new document and clears history", () => {
    const get = mountHistory();
    act(() => {
      addC5(get().documentRef.current, 0);
      get().commit();
    });
    expect(get().canUndo).toBe(true);

    const loaded = parseDocument(serializeDocument(createBlankDocument()));
    act(() => get().reset(loaded));
    expect(get().canUndo).toBe(false);
    expect(get().canRedo).toBe(false);
    expect(noteCount(get().documentRef.current)).toBe(0);
    // The freshly loaded document is the new clean baseline.
    expect(serializeDocument(get().documentRef.current)).toBe(
      get().baselineXml,
    );
  });
});
