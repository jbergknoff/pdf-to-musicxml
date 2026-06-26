import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Editing-flow integration tests for the editor. The design contract under test:
// a tap *selects* (or adds on empty staff) but never silently mutates an
// existing note, a multi-staff score is view-only, and undo/redo + the dirty
// indicator behave.

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);
// The grand-staff Mozart clip the unit tests also use — multiple staves +
// <backup>, so the editor treats it as view-only.
const GRAND_STAFF = fileURLToPath(
  new URL(
    "../src/__fixtures__/rondo-alla-turca-clip.musicxml",
    import.meta.url,
  ),
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

// Click the staff at a position (relative to the SVG) that lands inside the
// first measure.
async function tapStaff(
  page: Page,
  position: { x: number; y: number },
): Promise<void> {
  await page.locator("svg").first().click({ position });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  // The blank document renders its staff before we interact.
  await expect(page.locator("svg").first()).toBeVisible();
});

test("tapping empty staff adds a note; undo and redo reverse it", async ({
  page,
}) => {
  expect(pitchCount(await exportXml(page))).toBe(0);

  await tapStaff(page, { x: 150, y: 70 });
  expect(pitchCount(await exportXml(page))).toBe(1);

  await page.keyboard.press("Control+z");
  expect(pitchCount(await exportXml(page))).toBe(0);

  await page.keyboard.press("Control+Shift+z");
  expect(pitchCount(await exportXml(page))).toBe(1);
});

test("tapping an existing note selects it without adding a duplicate", async ({
  page,
}) => {
  // Place a note, then tap the very same spot again.
  await tapStaff(page, { x: 150, y: 70 });
  expect(pitchCount(await exportXml(page))).toBe(1);

  await tapStaff(page, { x: 150, y: 70 });
  // Still exactly one note — the second tap selected it, it did not add another.
  expect(pitchCount(await exportXml(page))).toBe(1);

  // And the note is now selected, so Delete is enabled and removes it.
  await page.getByRole("button", { name: "Delete" }).click();
  expect(pitchCount(await exportXml(page))).toBe(0);
});

test("the dirty indicator appears on edit and clears on export", async ({
  page,
}) => {
  await expect(page.getByText("Unsaved")).toHaveCount(0);

  await tapStaff(page, { x: 150, y: 70 });
  await expect(page.getByText("Unsaved")).toBeVisible();

  await exportXml(page);
  await expect(page.getByText("Unsaved")).toHaveCount(0);
});

test("an imported single-staff file is editable", async ({ page }) => {
  await importFile(page, SINGLE_STAFF);
  // The C/E/G quarter notes load.
  await expect.poll(async () => pitchCount(await exportXml(page))).toBe(3);
  await expect(page.getByText(/view-only/i)).toHaveCount(0);
});

test("an imported grand-staff score is view-only and taps never mutate it", async ({
  page,
}) => {
  await importFile(page, GRAND_STAFF);
  await expect(page.getByText(/view-only/i)).toBeVisible();

  // Undo/redo have nothing to act on; editing controls are inert.
  await expect(page.getByRole("button", { name: "Undo" })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Redo" })).toBeDisabled();

  const before = await exportXml(page);
  // Tap squarely on the staff where notes are drawn.
  await tapStaff(page, { x: 200, y: 80 });
  await tapStaff(page, { x: 260, y: 120 });
  const after = await exportXml(page);

  // The document is byte-for-byte unchanged — clicking did not edit the file.
  expect(after).toBe(before);
});
