import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Editing-flow integration tests for the editor. The design contract under test:
// tapping the staff only selects (it never inserts a note), tapping empty space
// clears the selection, a selected note can be deleted/undone, a multi-voice
// score is view-only, and the dirty indicator behaves.

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);
// A minimal single-staff score with two voices (backup element present) —
// the editor treats multi-voice documents as view-only.
const MULTI_VOICE = fileURLToPath(
  new URL("./fixtures/multi-voice.musicxml", import.meta.url),
);

// Export the current document and return the serialized MusicXML.
async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  const path = await download.path();
  return readFileSync(path, "utf8");
}

async function importFile(page: Page, filePath: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(filePath);
}

function pitchCount(xml: string): number {
  return (xml.match(/<pitch>/g) ?? []).length;
}

function restCount(xml: string): number {
  return (xml.match(/<rest\b/g) ?? []).length;
}

// The first measure's note/rest run in document order: each note rendered as
// `<step><octave>` (e.g. "E5") and each rest as "REST". Used to assert a pitch
// edit kept the note in place rather than shoving it rightward behind a rest.
function noteSequence(xml: string): string[] {
  const measure = xml.split("<measure")[1] ?? "";
  const tokens: string[] = [];
  const noteRe = /<note\b[^>]*>([\s\S]*?)<\/note>/g;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: regex scan loop
  while ((match = noteRe.exec(measure)) !== null) {
    const body = match[1];
    if (/<rest\b/.test(body)) {
      tokens.push("REST");
      continue;
    }
    const step = body.match(/<step>(\w)<\/step>/)?.[1] ?? "?";
    const octave = body.match(/<octave>(\d)<\/octave>/)?.[1] ?? "?";
    tokens.push(`${step}${octave}`);
  }
  return tokens;
}

// Load the single-staff fixture (three quarter notes C/E/G) and wait for it.
async function loadSingleStaff(page: Page): Promise<void> {
  await importFile(page, SINGLE_STAFF);
  // The first notehead carries the score id p{part}-m{measureNumber}-n{i}-v{v}.
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("tapping empty staff does not insert a note", async ({ page }) => {
  // The blank document starts with no notes.
  expect(pitchCount(await exportXml(page))).toBe(0);

  // Tap several empty spots on the staff.
  await page
    .locator("svg")
    .first()
    .click({ position: { x: 150, y: 70 } });
  await page
    .locator("svg")
    .first()
    .click({ position: { x: 320, y: 90 } });
  await page
    .locator("svg")
    .first()
    .click({ position: { x: 480, y: 50 } });

  // Still no notes — clicking empty space never inserts.
  expect(pitchCount(await exportXml(page))).toBe(0);
  // And nothing was committed, so there's nothing to undo.
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
});

test("tapping a note selects it; Delete removes it; undo/redo reverse that", async ({
  page,
}) => {
  await loadSingleStaff(page);
  expect(pitchCount(await exportXml(page))).toBe(3);

  // Tapping the first notehead selects it (Delete becomes enabled) without
  // changing the document.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeEnabled();
  expect(pitchCount(await exportXml(page))).toBe(3);

  await page.getByRole("button", { name: "Delete" }).click();
  expect(pitchCount(await exportXml(page))).toBe(2);

  await page.keyboard.press("Control+z");
  expect(pitchCount(await exportXml(page))).toBe(3);

  await page.keyboard.press("Control+Shift+z");
  expect(pitchCount(await exportXml(page))).toBe(2);
});

test("stepping a note's pitch up keeps its onset (no rest inserted to its left)", async ({
  page,
}) => {
  await loadSingleStaff(page);
  // The fixture is three quarter notes C5 E5 G5 then a quarter rest.
  const before = await exportXml(page);
  expect(noteSequence(before)).toEqual(["C5", "E5", "G5", "REST"]);
  expect(restCount(before)).toBe(1);

  // Select the middle note (E5, beat 2) and raise its pitch one staff step via
  // the inspector's "Up one step" stepper.
  await page.locator("#p0-m1-n1-v0").click();
  await page.getByTitle("Up one step").first().click();

  // Only the pitch changes: E5 → F5 in the same slot. The note must NOT be
  // pushed rightward behind a freshly inserted rest — the rest count is
  // unchanged and the sequence keeps the note at beat 2 (this is the bug the
  // test guards against).
  const after = await exportXml(page);
  expect(noteSequence(after)).toEqual(["C5", "F5", "G5", "REST"]);
  expect(restCount(after)).toBe(1);
  expect(pitchCount(after)).toBe(3);
});

test("tapping empty space clears the selection", async ({ page }) => {
  await loadSingleStaff(page);
  await page.locator("#p0-m1-n0-v0").click();
  await expect(page.getByRole("button", { name: "Delete" })).toBeEnabled();

  // A tap on an empty region of the staff deselects. The notes sit at the left
  // of the single measure; the top-right corner of the SVG is empty.
  const box = await page.locator("svg").first().boundingBox();
  if (!box) {
    throw new Error("staff SVG has no bounding box");
  }
  await page.mouse.click(box.x + box.width - 6, box.y + 6);
  await expect(page.getByRole("button", { name: "Delete" })).toBeDisabled();
});

test("the dirty indicator appears on edit and clears on export", async ({
  page,
}) => {
  await loadSingleStaff(page);
  // A freshly imported document is clean.
  await expect(page.getByText("Unsaved")).toHaveCount(0);

  await page.locator("#p0-m1-n0-v0").click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Unsaved")).toBeVisible();

  await exportXml(page);
  await expect(page.getByText("Unsaved")).toHaveCount(0);
});

test("an imported single-staff file is editable", async ({ page }) => {
  await loadSingleStaff(page);
  expect(pitchCount(await exportXml(page))).toBe(3);
  await expect(page.getByText(/view-only/i)).toHaveCount(0);
});

test("a multi-voice score is view-only", async ({ page }) => {
  await importFile(page, MULTI_VOICE);
  await expect(page.getByText(/view-only/i)).toBeVisible();

  // Undo/redo have nothing to act on; editing controls are inert.
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();
});
