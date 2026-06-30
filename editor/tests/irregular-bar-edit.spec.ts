import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Regression for the chord-edit corruption seen on imported grand-staff scores
// (the Chrono Trigger fixture): stepping a chord member's pitch in an over-full
// bar (one whose real length differs from the time signature) rewrote the whole
// measure — the bar restructured, the bass staff shifted, and a phantom
// step-less note (labelled just "5") appeared in the chord. The fixture's single
// bar is 4/4 nominal but holds 5 quarters, with a mismatched-duration chord
// (G5/E5 quarters over a C5 eighth) alongside the chord under edit.

const IRREGULAR = fileURLToPath(
  new URL("./fixtures/irregular-grand-staff.musicxml", import.meta.url),
);

async function exportXml(page: Page): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  return readFileSync(await download.path(), "utf8");
}

async function loadFile(page: Page, path: string): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(path);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

// Click a notehead by its glyph center, in viewport coordinates. On a grand
// staff the bass note's glyph box can intercept a direct element click, so —
// like click-highlight.spec.ts — resolve the center and click the point.
async function clickNotehead(page: Page, id: string): Promise<void> {
  const box = await page.locator(id).boundingBox();
  if (!box) {
    throw new Error(`notehead ${id} has no bounding box`);
  }
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}

// Note-pitch label buttons in the inspector panel.
function pitchButtons(page: Page) {
  return page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: /^[A-G][♯♭]*\d$/ });
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("stepping a chord member in an over-full bar keeps the bar intact", async ({
  page,
}) => {
  await loadFile(page, IRREGULAR);
  const inspector = page.locator("aside");

  // Select the beat-1 chord (C5 over A4) → Level 1. Clicking the low A4 notehead
  // selects the whole beat; the inspector lists it top-first as C5, A4.
  await clickNotehead(page, "#p0-m1-n0-v0");
  await expect(inspector.getByText("Beat", { exact: true })).toBeVisible();
  await expect(inspector.getByText("2 notes", { exact: false })).toBeVisible();
  await expect(pitchButtons(page)).toHaveText(["C5", "A4"]);

  // Click the top row's "Up one step" stepper: C5 → D5.
  await inspector.getByTitle("Up one step").first().click();

  // The chord is now D5 over A4 — still exactly two notes. The bug turned this
  // into "3 notes" with a phantom "5" row; guard against both.
  await expect(inspector.getByText("2 notes", { exact: false })).toBeVisible();
  await expect(inspector.getByText("3 notes", { exact: false })).toHaveCount(0);
  await expect(pitchButtons(page)).toHaveText(["D5", "A4"]);

  // The rendered staves stay intact: the over-full bar keeps its five beats and
  // the bass is untouched (no shift, no phantom notehead).
  await expect(page.locator("svg").first()).toHaveScreenshot(
    "irregular-bar-after-step.png",
  );

  // The exported MusicXML confirms it structurally: the stepped note is D5, no
  // note lost its <step>, and the bass whole-note C3 + quarter G2 survive.
  const xml = await exportXml(page);
  expect(xml).not.toContain("<step></step>");
  expect(xml).toMatch(/<step>D<\/step>\s*<octave>5<\/octave>/);
  expect(xml).toMatch(/<step>C<\/step>\s*<octave>3<\/octave>/);
  expect(xml).toMatch(/<step>G<\/step>\s*<octave>2<\/octave>/);
  // The inter-staff backup is sized to the bar's real length (20), not the 4/4
  // nominal (16) — that mismatch was what desynced the staves.
  expect(xml).toMatch(/<backup>\s*<duration>20<\/duration>\s*<\/backup>/);
});
