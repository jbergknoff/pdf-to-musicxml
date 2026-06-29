import { describe, expect, test } from "bun:test";
import { createBlankDocument, serializeDocument } from "./dom-edit";
import {
  type EditableMetadata,
  readMetadata,
  stampImportProvenance,
  writeMetadata,
} from "./metadata";

const EMPTY_EDITABLE: EditableMetadata = {
  workTitle: "",
  movementTitle: "",
  composer: "",
  lyricist: "",
  arranger: "",
  rights: "",
  source: "",
};

// The order of `<score-partwise>` direct children, used to assert the DTD-valid
// placement of inserted metadata elements.
function childTags(doc: Document): string[] {
  return Array.from(doc.documentElement.children).map((el) =>
    el.tagName.toLowerCase(),
  );
}

describe("readMetadata", () => {
  test("returns empty fields for a blank score", () => {
    const meta = readMetadata(createBlankDocument());
    expect(meta.workTitle).toBe("");
    expect(meta.composer).toBe("");
    expect(meta.source).toBe("");
    expect(meta.encoding.software).toEqual([]);
    expect(meta.miscellaneous).toEqual([]);
  });

  test("reads standard metadata elements", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, {
      ...EMPTY_EDITABLE,
      workTitle: "Sonata",
      movementTitle: "Allegro",
      composer: "Mozart",
      lyricist: "Da Ponte",
      arranger: "Liszt",
      rights: "© 2026",
      source: "First edition",
    });
    const meta = readMetadata(doc);
    expect(meta.workTitle).toBe("Sonata");
    expect(meta.movementTitle).toBe("Allegro");
    expect(meta.composer).toBe("Mozart");
    expect(meta.lyricist).toBe("Da Ponte");
    expect(meta.arranger).toBe("Liszt");
    expect(meta.rights).toBe("© 2026");
    expect(meta.source).toBe("First edition");
  });
});

describe("writeMetadata", () => {
  test("inserts work / movement-title / identification before part-list", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, {
      ...EMPTY_EDITABLE,
      workTitle: "W",
      movementTitle: "M",
      composer: "C",
    });
    const tags = childTags(doc);
    expect(tags).toEqual([
      "work",
      "movement-title",
      "identification",
      "part-list",
      "part",
    ]);
  });

  test("creator elements carry the right type and order before rights", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, {
      ...EMPTY_EDITABLE,
      composer: "C",
      rights: "R",
    });
    const ident = doc.querySelector("identification");
    const children = Array.from(ident?.children ?? []).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
    }));
    expect(children).toEqual([
      { tag: "creator", type: "composer" },
      { tag: "rights", type: null },
    ]);
  });

  test("clearing a field removes its element and prunes empty containers", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, { ...EMPTY_EDITABLE, workTitle: "W", composer: "C" });
    expect(doc.querySelector("work")).not.toBeNull();
    expect(doc.querySelector("identification")).not.toBeNull();

    writeMetadata(doc, EMPTY_EDITABLE);
    expect(doc.querySelector("work")).toBeNull();
    expect(doc.querySelector("identification")).toBeNull();
    expect(doc.querySelector("movement-title")).toBeNull();
  });

  test("updates an existing field in place rather than duplicating it", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, { ...EMPTY_EDITABLE, composer: "First" });
    writeMetadata(doc, { ...EMPTY_EDITABLE, composer: "Second" });
    const creators = doc.querySelectorAll("creator");
    expect(creators.length).toBe(1);
    expect(readMetadata(doc).composer).toBe("Second");
  });

  test("round-trips through serialize + reparse", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, {
      ...EMPTY_EDITABLE,
      workTitle: "Title",
      composer: "Composer",
    });
    const xml = serializeDocument(doc);
    const reparsed = new DOMParser().parseFromString(xml, "text/xml");
    const meta = readMetadata(reparsed);
    expect(meta.workTitle).toBe("Title");
    expect(meta.composer).toBe("Composer");
  });
});

describe("stampImportProvenance", () => {
  test("records encoding, source, and import-* miscellaneous fields", () => {
    const doc = createBlankDocument();
    const date = new Date("2026-06-29T12:34:56.000Z");
    stampImportProvenance(doc, {
      method: "optical-music-recognition",
      sourceFile: "scan.pdf",
      date,
    });
    const meta = readMetadata(doc);
    expect(meta.encoding.software).toContain("musicxml-editor");
    expect(meta.encoding.encodingDate).toBe("2026-06-29");
    expect(meta.encoding.encodingDescription).toContain("scan.pdf");
    expect(meta.encoding.encodingDescription).toContain(
      "optical music recognition",
    );
    expect(meta.source).toContain("scan.pdf");

    const byName = Object.fromEntries(
      meta.miscellaneous.map((field) => [field.name, field.value]),
    );
    expect(byName["import-method"]).toBe("optical-music-recognition");
    expect(byName["import-source-file"]).toBe("scan.pdf");
    expect(byName["import-date"]).toBe("2026-06-29T12:34:56.000Z");
  });

  test("places identification before part-list and is idempotent per field", () => {
    const doc = createBlankDocument();
    stampImportProvenance(doc, {
      method: "midi-conversion",
      sourceFile: "song.mid",
    });
    stampImportProvenance(doc, {
      method: "midi-conversion",
      sourceFile: "song.mid",
    });
    expect(childTags(doc)).toEqual(["identification", "part-list", "part"]);
    // Re-stamping overwrites rather than duplicating.
    expect(doc.querySelectorAll("software").length).toBe(1);
    expect(doc.querySelectorAll("source").length).toBe(1);
    expect(
      doc.querySelectorAll('miscellaneous-field[name="import-method"]').length,
    ).toBe(1);
  });

  test("does not disturb user-set editable metadata", () => {
    const doc = createBlankDocument();
    writeMetadata(doc, { ...EMPTY_EDITABLE, composer: "Bach" });
    stampImportProvenance(doc, {
      method: "midi-conversion",
      sourceFile: "song.mid",
    });
    expect(readMetadata(doc).composer).toBe("Bach");
  });
});
