import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Integration tests for the selection overlay chrome (PR #28):
//   - Level 1 beat-box: a tinted rect column over the selected beat.
//   - Level 2 note ring: a circle over the drilled notehead, beat-box becomes
//     dashed.
//   - Reselect after chord-member removal: removing one note from a multi-note
//     chord re-selects the remaining chord rather than clearing to null.
//   - Key-signature-aware pitch stepping: ↑/↓ stays diatonic in the active key
//     (F→F♯ in G major, not F♮).

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);
// G major (1 sharp = F♯): E5, G5, B5 quarter notes + a rest.
const G_MAJOR = fileURLToPath(
  new URL("./fixtures/g-major.musicxml", import.meta.url),
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

// ── Screenshots: beat-box and note ring ─────────────────────────────────────

test("Level 1: beat-box column appears over the selected beat", async ({
  page,
}) => {
  await loadFile(page, SINGLE_STAFF);

  // Click the first notehead → Level 1 (whole-chord selection).
  await page.locator("#p0-m1-n0-v0").click();
  await expect(
    page.locator("aside").getByText("Beat", { exact: true }),
  ).toBeVisible();

  // The staff SVG should show a tinted beat-box over the C5 column.
  await expect(page.locator("svg").first()).toHaveScreenshot(
    "beat-box-level1.png",
  );
});

test("Level 2: dashed beat-box and note ring over the drilled note", async ({
  page,
}) => {
  await loadFile(page, SINGLE_STAFF);

  // First click → Level 1; second click on same notehead → Level 2.
  await page.locator("#p0-m1-n0-v0").click();
  await page.locator("#p0-m1-n0-v0").click();
  await expect(
    page.locator("aside").getByText("Note", { exact: true }),
  ).toBeVisible();

  // The staff SVG should show a dashed beat-box + a ring over the notehead.
  await expect(page.locator("svg").first()).toHaveScreenshot(
    "beat-box-and-ring-level2.png",
  );
});

// ── Reselect after removing a chord member ───────────────────────────────────

test("removing one note from a chord keeps the inspector on the remaining chord", async ({
  page,
}) => {
  await loadFile(page, SINGLE_STAFF);
  const inspector = page.locator("aside");

  // Select beat 1 (C5), then add E5 to form a two-note chord.
  await page.locator("#p0-m1-n0-v0").click();
  await page.keyboard.press("e");

  // Two note rows appear: E5 (top) and C5 (bottom).
  await expect(pitchButtons(page)).toHaveCount(2);

  // Drill to Level 2 (focuses the top note, E5).
  await page.keyboard.press("Enter");
  await expect(inspector.getByText("Note", { exact: true })).toBeVisible();

  // Remove the focused note via the ✕ button in its inspector row.
  await inspector.getByTitle("Remove note").first().click();

  // The inspector must stay open at Level 1 on the remaining chord (C5),
  // not close to idle — that was the bug.
  await expect(inspector.getByText("Beat", { exact: true })).toBeVisible();
  await expect(pitchButtons(page)).toHaveCount(1);
});

// ── Key-signature-aware pitch stepping ──────────────────────────────────────

test("↑ steps into F♯ (not F♮) when the key signature is G major", async ({
  page,
}) => {
  await loadFile(page, G_MAJOR); // E5 is note 0; key = G major (F♯)

  // Select E5 (Level 1) then drill in to Level 2.
  await page.locator("#p0-m1-n0-v0").click();
  await expect(
    page.locator("aside").getByText("Beat", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(
    page.locator("aside").getByText("Note", { exact: true }),
  ).toBeVisible();

  // Step up once: E → F, and F is ♯ in G major.
  await page.keyboard.press("ArrowUp");

  // The exported pitch should have alter=1 (F♯), not the old alter=0 (F♮).
  const xml = await exportXml(page);
  expect(xml).toMatch(/<step>F<\/step>\s*<alter>1<\/alter>/);
});
