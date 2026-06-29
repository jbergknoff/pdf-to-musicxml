import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// The design handoff's core selection loop: click a notehead to drill to a note
// (Level 2), see it mirrored in the inspector, and edit it via the inspector
// controls and the keyboard map (Esc step-out, A–G add, accidentals, + Measure).

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

function pitchCount(xml: string): number {
  return (xml.match(/<pitch>/g) ?? []).length;
}

function measureCount(xml: string): number {
  return (xml.match(/<measure /g) ?? []).length;
}

// The inspector's first pitch-label button (text like "E5" / "F♯5") — used
// pitch-agnostically since which beat a notehead click resolves to depends on
// the renderer's hit-test geometry.
function pitchButton(page: Page) {
  return page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: /^[A-G][♯♭]*\d$/ })
    .first();
}

// Load the single-staff fixture (three quarter notes C5/E5/G5) and wait for it.
async function loadSingleStaff(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("clicking selects the beat; a second click drills to the note", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  // Before any selection the inspector shows its empty state.
  await expect(inspector.getByText("Idle")).toBeVisible();
  await expect(inspector.getByText(/click a beat/i)).toBeVisible();

  // First click on a notehead selects its beat (Level 1); the header names the
  // time-position and the chord's note is listed.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(inspector.getByText("Beat", { exact: true })).toBeVisible();
  await expect(inspector.getByText(/Measure 1 .* Beat \d/)).toBeVisible();
  await expect(pitchButton(page)).toBeVisible();

  // A second click on the same notehead narrows to that one note (Level 2).
  await page.locator("#p0-m1-n0-v0").click();
  await expect(inspector.getByText("Note", { exact: true })).toBeVisible();
});

test("the inspector sets an accidental on the selected note", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  await page.locator("#p0-m1-n0-v0").click();
  await inspector.getByTitle("Sharp").click();

  // The export carries the alteration and the row label gains a sharp.
  expect(await exportXml(page)).toContain("<alter>1</alter>");
  await expect(pitchButton(page)).toHaveText(/♯/);
});

test("the inspector stepper moves the note up a staff-step", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  await page.locator("#p0-m1-n0-v0").click();
  const before = (await pitchButton(page).textContent()) ?? "";
  await inspector.getByTitle("Up one step").click();
  // The note moved, so its label changed.
  await expect(pitchButton(page)).not.toHaveText(before);
});

test("Add note stacks a chord member on the selected beat", async ({
  page,
}) => {
  await loadSingleStaff(page);
  expect(pitchCount(await exportXml(page))).toBe(3);

  await page.locator("#p0-m1-n0-v0").click();
  await page.locator("aside").getByText("+ Add note").click();

  // The beat now has two stacked notes (a third up), so a fourth pitch overall.
  expect(pitchCount(await exportXml(page))).toBe(4);
});

test("Esc steps out Note → Beat → idle without deleting", async ({ page }) => {
  await loadSingleStaff(page);
  const inspector = page.locator("aside");

  // Click selects the beat; Enter drills into the top note (Level 2).
  await page.locator("#p0-m1-n0-v0").click();
  await page.keyboard.press("Enter");
  await expect(inspector.getByText("Note", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(inspector.getByText("Beat", { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(inspector.getByText(/click a beat/i)).toBeVisible();

  // Nothing was deleted by stepping out.
  expect(pitchCount(await exportXml(page))).toBe(3);
});

test("a letter key adds a note to the selected beat", async ({ page }) => {
  await loadSingleStaff(page);
  await page.locator("#p0-m1-n0-v0").click();
  await page.keyboard.press("e");
  expect(pitchCount(await exportXml(page))).toBe(4);
});

test("the + Measure button appends a measure", async ({ page }) => {
  await loadSingleStaff(page);
  expect(measureCount(await exportXml(page))).toBe(1);

  await page.getByRole("button", { name: "+ Measure" }).click();
  expect(measureCount(await exportXml(page))).toBe(2);
});
