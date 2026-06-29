// Score-level metadata, read from and written to the live MusicXML `Document`
// the same doc-as-source-of-truth way `dom-edit` handles notes.
//
// MusicXML has a standard place for metadata: the top-level `<work>` /
// `<movement-title>` elements and the `<identification>` block (composer and
// other `<creator>`s, `<rights>`, the `<encoding>` software/date, a free-text
// `<source>`, and an open-ended `<miscellaneous>` bag of name/value fields).
// All of these are children of `<score-partwise>` *before* `<part-list>`, and
// the DTD fixes their relative order, so every insertion here threads the new
// element into the correct slot rather than appending blindly.

// The handful of human-authored fields the metadata editor exposes. Each maps
// to one standard MusicXML element; an empty string means "not set" (the
// element is removed on write).
export interface EditableMetadata {
  /** `<work>/<work-title>` — the title of the overall work. */
  workTitle: string;
  /** `<movement-title>` — the title of this movement. */
  movementTitle: string;
  /** `<identification>/<creator type="composer">`. */
  composer: string;
  /** `<identification>/<creator type="lyricist">`. */
  lyricist: string;
  /** `<identification>/<creator type="arranger">`. */
  arranger: string;
  /** `<identification>/<rights>` — copyright line. */
  rights: string;
  /** `<identification>/<source>` — a description of the music's source. */
  source: string;
}

// The `<encoding>` block — who/what/when produced this file. Read-only in the
// UI; populated by `stampImportProvenance` (and by any other tool's export).
export interface EncodingInfo {
  software: string[];
  encodingDate: string | null;
  encodingDescription: string | null;
  encoder: string | null;
}

/** One `<miscellaneous-field name="…">value</…>` entry. */
export interface MiscField {
  name: string;
  value: string;
}

// Everything the metadata editor reads back: the editable fields plus the
// read-only encoding/provenance the file carries.
export interface ScoreMetadata extends EditableMetadata {
  encoding: EncodingInfo;
  miscellaneous: MiscField[];
}

// DTD child order for `<score-partwise>` (the subset we touch). insertInOrder
// uses this to drop `<work>` / `<movement-title>` / `<identification>` ahead of
// `<part-list>` / `<part>`.
const SCORE_ORDER = [
  "work",
  "movement-number",
  "movement-title",
  "identification",
  "defaults",
  "credit",
  "part-list",
  "part",
];

// DTD child order for `<identification>`.
const IDENTIFICATION_ORDER = [
  "creator",
  "rights",
  "encoding",
  "source",
  "relation",
  "miscellaneous",
];

// `<encoding>` children may appear in any order and repeat; this list just keeps
// our insertions tidy.
const ENCODING_ORDER = [
  "encoding-date",
  "encoder",
  "software",
  "encoding-description",
  "supports",
];

// `<work>` children order.
const WORK_ORDER = ["work-number", "work-title", "opus"];

// The product name stamped into `<software>` and used to identify our own
// `<miscellaneous>` provenance fields.
export const SOFTWARE_NAME = "musicxml-editor";

// ── Element plumbing ──────────────────────────────────────────────────────────

function directChildren(parent: Element, tag: string): Element[] {
  return Array.from(parent.children).filter(
    (child) => child.tagName.toLowerCase() === tag,
  );
}

function firstChild(parent: Element, tag: string): Element | null {
  return directChildren(parent, tag)[0] ?? null;
}

function textOf(parent: Element | null, tag: string): string {
  if (!parent) {
    return "";
  }
  return firstChild(parent, tag)?.textContent?.trim() ?? "";
}

// Insert `el` among `parent`'s children at the slot its tag occupies in `order`
// (before the first existing child that sorts after it, else appended). Keeps
// the document valid against the MusicXML DTD's fixed element order.
function insertInOrder(parent: Element, el: Element, order: string[]): void {
  const rank = order.indexOf(el.tagName.toLowerCase());
  for (const child of Array.from(parent.children)) {
    const childRank = order.indexOf(child.tagName.toLowerCase());
    if (childRank > rank) {
      parent.insertBefore(el, child);
      return;
    }
  }
  parent.appendChild(el);
}

// Get the first child with `tag`, creating and order-inserting it if absent.
function ensureChild(
  doc: Document,
  parent: Element,
  tag: string,
  order: string[],
): Element {
  const existing = firstChild(parent, tag);
  if (existing) {
    return existing;
  }
  const el = doc.createElement(tag);
  insertInOrder(parent, el, order);
  return el;
}

// Set (or, for an empty value, remove) a simple text child element.
function setTextChild(
  doc: Document,
  parent: Element,
  tag: string,
  order: string[],
  value: string,
): void {
  const trimmed = value.trim();
  const existing = firstChild(parent, tag);
  if (!trimmed) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = trimmed;
    return;
  }
  const el = doc.createElement(tag);
  el.textContent = trimmed;
  insertInOrder(parent, el, order);
}

function findCreator(identification: Element, type: string): Element | null {
  return (
    directChildren(identification, "creator").find(
      (creator) => (creator.getAttribute("type") ?? "") === type,
    ) ?? null
  );
}

function creatorText(identification: Element | null, type: string): string {
  if (!identification) {
    return "";
  }
  return findCreator(identification, type)?.textContent?.trim() ?? "";
}

// Set (or remove) the `<creator>` of a given `type`. Creators all share the same
// DTD rank, so order among them does not matter.
function setCreator(
  doc: Document,
  identification: Element,
  type: string,
  value: string,
): void {
  const trimmed = value.trim();
  const existing = findCreator(identification, type);
  if (!trimmed) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = trimmed;
    return;
  }
  const el = doc.createElement("creator");
  el.setAttribute("type", type);
  el.textContent = trimmed;
  insertInOrder(identification, el, IDENTIFICATION_ORDER);
}

// Set a `<miscellaneous-field>` by name, creating it if absent (these have no
// fixed order, so a plain append is fine).
function setMiscField(
  doc: Document,
  miscellaneous: Element,
  name: string,
  value: string,
): void {
  let field = directChildren(miscellaneous, "miscellaneous-field").find(
    (candidate) => candidate.getAttribute("name") === name,
  );
  if (!field) {
    field = doc.createElement("miscellaneous-field");
    field.setAttribute("name", name);
    miscellaneous.appendChild(field);
  }
  field.textContent = value;
}

// Remove a container element if it has no element children left, so clearing
// every field doesn't leave an empty `<work>` / `<identification>` behind.
function pruneIfEmpty(el: Element | null): void {
  if (el && el.children.length === 0) {
    el.remove();
  }
}

// ── Read ──────────────────────────────────────────────────────────────────────

export function readMetadata(doc: Document): ScoreMetadata {
  const root = doc.documentElement;
  const work = firstChild(root, "work");
  const identification = firstChild(root, "identification");
  const encoding = identification
    ? firstChild(identification, "encoding")
    : null;
  const miscellaneous = identification
    ? firstChild(identification, "miscellaneous")
    : null;

  return {
    workTitle: textOf(work, "work-title"),
    movementTitle: textOf(root, "movement-title"),
    composer: creatorText(identification, "composer"),
    lyricist: creatorText(identification, "lyricist"),
    arranger: creatorText(identification, "arranger"),
    rights: textOf(identification, "rights"),
    source: textOf(identification, "source"),
    encoding: {
      software: encoding
        ? directChildren(encoding, "software").map(
            (el) => el.textContent?.trim() ?? "",
          )
        : [],
      encodingDate: encoding
        ? (firstChild(encoding, "encoding-date")?.textContent?.trim() ?? null)
        : null,
      encodingDescription: encoding
        ? (firstChild(encoding, "encoding-description")?.textContent?.trim() ??
          null)
        : null,
      encoder: encoding
        ? (firstChild(encoding, "encoder")?.textContent?.trim() ?? null)
        : null,
    },
    miscellaneous: miscellaneous
      ? directChildren(miscellaneous, "miscellaneous-field").map((field) => ({
          name: field.getAttribute("name") ?? "",
          value: field.textContent?.trim() ?? "",
        }))
      : [],
  };
}

// ── Write ─────────────────────────────────────────────────────────────────────

// Reconcile the editable fields into the document, creating/removing the
// standard elements as needed and pruning containers that end up empty.
export function writeMetadata(doc: Document, meta: EditableMetadata): void {
  const root = doc.documentElement;

  // <work>/<work-title>
  if (meta.workTitle.trim()) {
    const work = ensureChild(doc, root, "work", SCORE_ORDER);
    setTextChild(doc, work, "work-title", WORK_ORDER, meta.workTitle);
  } else {
    const work = firstChild(root, "work");
    if (work) {
      setTextChild(doc, work, "work-title", WORK_ORDER, "");
      pruneIfEmpty(work);
    }
  }

  // <movement-title>
  setTextChild(doc, root, "movement-title", SCORE_ORDER, meta.movementTitle);

  // <identification> block.
  const wantsIdentification = Boolean(
    meta.composer.trim() ||
      meta.lyricist.trim() ||
      meta.arranger.trim() ||
      meta.rights.trim() ||
      meta.source.trim(),
  );
  let identification = firstChild(root, "identification");
  if (!identification && wantsIdentification) {
    identification = ensureChild(doc, root, "identification", SCORE_ORDER);
  }
  if (identification) {
    setCreator(doc, identification, "composer", meta.composer);
    setCreator(doc, identification, "lyricist", meta.lyricist);
    setCreator(doc, identification, "arranger", meta.arranger);
    setTextChild(
      doc,
      identification,
      "rights",
      IDENTIFICATION_ORDER,
      meta.rights,
    );
    setTextChild(
      doc,
      identification,
      "source",
      IDENTIFICATION_ORDER,
      meta.source,
    );
    // Leave the block in place if it still holds encoding/provenance, otherwise
    // remove the now-empty shell.
    pruneIfEmpty(identification);
  }
}

// ── Import provenance ─────────────────────────────────────────────────────────

/** How an imported document was produced, for the provenance stamp. */
export type ImportMethod =
  | "optical-music-recognition"
  | "midi-conversion"
  | "musicxml"
  | "compressed-musicxml";

const METHOD_LABEL: Record<ImportMethod, string> = {
  "optical-music-recognition": "optical music recognition",
  "midi-conversion": "MIDI conversion",
  musicxml: "MusicXML import",
  "compressed-musicxml": "compressed MusicXML import",
};

// Record how/when/from-what a document was imported into the standard
// `<identification>` block: an `<encoding>` (software + date + description), a
// human-readable `<source>`, and structured `<miscellaneous-field>`s under the
// reserved `import-*` names. Idempotent per field — re-stamping overwrites
// rather than duplicating. Mutates `doc` in place.
export function stampImportProvenance(
  doc: Document,
  info: { method: ImportMethod; sourceFile: string; date?: Date },
): void {
  const root = doc.documentElement;
  const now = info.date ?? new Date();
  const isoDate = now.toISOString().slice(0, 10); // yyyy-mm-dd, per the DTD
  const label = METHOD_LABEL[info.method];
  const description = info.sourceFile
    ? `Imported from "${info.sourceFile}" via ${label}`
    : `Imported via ${label}`;

  const identification = ensureChild(doc, root, "identification", SCORE_ORDER);

  const encoding = ensureChild(
    doc,
    identification,
    "encoding",
    IDENTIFICATION_ORDER,
  );
  setTextChild(doc, encoding, "software", ENCODING_ORDER, SOFTWARE_NAME);
  setTextChild(doc, encoding, "encoding-date", ENCODING_ORDER, isoDate);
  setTextChild(
    doc,
    encoding,
    "encoding-description",
    ENCODING_ORDER,
    description,
  );

  setTextChild(
    doc,
    identification,
    "source",
    IDENTIFICATION_ORDER,
    description,
  );

  const miscellaneous = ensureChild(
    doc,
    identification,
    "miscellaneous",
    IDENTIFICATION_ORDER,
  );
  setMiscField(doc, miscellaneous, "import-method", info.method);
  if (info.sourceFile) {
    setMiscField(doc, miscellaneous, "import-source-file", info.sourceFile);
  }
  setMiscField(doc, miscellaneous, "import-date", now.toISOString());
}
