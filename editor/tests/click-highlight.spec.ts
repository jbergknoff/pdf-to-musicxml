import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";

// Integration tests pinning down *which* note a staff click highlights. The
// selection-first model resolves a click to a beat by snapping its x to the
// nearest onset on the rhythm spine (hit-test `beatFromX`), then picks the real
// note at that beat whose pitch is nearest the click's y (`pickNote`). These
// tests exercise that resolution from several click positions so a regression
// that highlights a surprising note is caught:
//   - a click on a notehead highlights exactly that note;
//   - a click in the gap between two notes snaps to the nearer onset;
//   - a click off the notehead vertically still highlights the note at that beat
//     (the onset anchors the pick — pitch only breaks ties);
//   - a click on a rest selects that rest's spine slot (no notehead is tinted,
//     but the inspector shows the rest position) — rests are selectable.

const SINGLE_STAFF = fileURLToPath(
  new URL("./fixtures/single-staff.musicxml", import.meta.url),
);

// Mirrors Editor.tsx's CHORD_TINT: a Level-1 (whole-beat) selection tints its
// notehead glyphs this color on the score. The highlight is drawn as a separate
// recolored glyph wrapped in `<g data-color-id="{noteId}">` (NoteColorOverlay),
// laid over the black ink note — so a highlighted note is identified by the
// presence of that overlay group, not by the original notehead's fill.
const CHORD_TINT = "#84a9e8";

async function loadSingleStaff(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(SINGLE_STAFF);
  // The fixture is three quarter notes C5 E5 G5 then a quarter rest.
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
}

// The inspector's note-label buttons (e.g. "C5", "F♯5").
function pitchButtons(page: Page): Locator {
  return page
    .locator("aside")
    .getByRole("button")
    .filter({ hasText: /^[A-G][♯♭]*\d$/ });
}

// Center of a notehead glyph, in viewport coordinates.
async function noteheadCenter(
  page: Page,
  id: string,
): Promise<{ x: number; y: number }> {
  const box = await page.locator(id).boundingBox();
  if (!box) {
    throw new Error(`notehead ${id} has no bounding box`);
  }
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

// Assert the selection landed on exactly the expected note: the inspector names
// its beat and lists only its pitch, and exactly that note (and no other) is
// tinted as selected on the score.
async function expectSelected(
  page: Page,
  expected: { beat: number; label: string; noteId: string },
): Promise<void> {
  const aside = page.locator("aside");
  await expect(
    aside.getByText(`Measure 1 · Beat ${expected.beat}`),
  ).toBeVisible();
  await expect(pitchButtons(page)).toHaveCount(1);
  await expect(pitchButtons(page).first()).toHaveText(expected.label);
  // Exactly one note is highlighted, and it is the expected one — drawn tinted.
  await expect(page.locator("g[data-color-id]")).toHaveCount(1);
  const overlay = page.locator(`g[data-color-id="${expected.noteId}"]`);
  await expect(overlay).toHaveCount(1);
  await expect(overlay.locator("text").last()).toHaveAttribute(
    "fill",
    CHORD_TINT,
  );
}

// Assert a rest slot is selected: the inspector names its position and shows the
// rest (no pitch rows), and no notehead is tinted on the score.
async function expectRestSelected(
  page: Page,
  expected: { beat: number; duration: string },
): Promise<void> {
  const aside = page.locator("aside");
  await expect(
    aside.getByText(`Measure 1 · Beat ${expected.beat}`),
  ).toBeVisible();
  await expect(aside.getByText(`Rest · ${expected.duration}`)).toBeVisible();
  await expect(pitchButtons(page)).toHaveCount(0);
  await expect(page.locator("g[data-color-id]")).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("clicking a notehead highlights exactly that note", async ({ page }) => {
  await loadSingleStaff(page);

  const cases = [
    { noteId: "p0-m1-n0-v0", beat: 1, label: "C5" },
    { noteId: "p0-m1-n1-v0", beat: 2, label: "E5" },
    { noteId: "p0-m1-n2-v0", beat: 3, label: "G5" },
  ];
  for (const target of cases) {
    const center = await noteheadCenter(page, `#${target.noteId}`);
    await page.mouse.click(center.x, center.y);
    await expectSelected(page, target);
  }
});

test("clicking the gap between notes snaps to the nearer onset", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const c0 = await noteheadCenter(page, "#p0-m1-n0-v0"); // C5, beat 1
  const c1 = await noteheadCenter(page, "#p0-m1-n1-v0"); // E5, beat 2
  const span = c1.x - c0.x;

  // A click 30% of the way from C5 toward E5 is nearer C5's onset.
  await page.mouse.click(c0.x + 0.3 * span, c0.y);
  await expectSelected(page, { beat: 1, label: "C5", noteId: "p0-m1-n0-v0" });

  // A click 70% of the way across is nearer E5's onset.
  await page.mouse.click(c0.x + 0.7 * span, c1.y);
  await expectSelected(page, { beat: 2, label: "E5", noteId: "p0-m1-n1-v0" });
});

test("clicking off a notehead vertically still highlights the note at that beat", async ({
  page,
}) => {
  await loadSingleStaff(page);
  const c0 = await noteheadCenter(page, "#p0-m1-n0-v0"); // C5
  const c1 = await noteheadCenter(page, "#p0-m1-n1-v0"); // E5, beat 2
  // C5→E5 spans one staff space (a third); offsetting E5 up by that much keeps
  // the click within pitch tolerance, so the onset still resolves to E5.
  const staffSpace = Math.abs(c0.y - c1.y);

  // A click a staff space above the notehead still resolves to E5's onset.
  await page.mouse.click(c1.x, c1.y - staffSpace);
  await expectSelected(page, { beat: 2, label: "E5", noteId: "p0-m1-n1-v0" });

  // Move the selection to C5 first — a repeat click on E5's beat would drill in
  // rather than re-select it — then click a staff space below the notehead.
  await page.mouse.click(c0.x, c0.y);
  await expectSelected(page, { beat: 1, label: "C5", noteId: "p0-m1-n0-v0" });

  await page.mouse.click(c1.x, c1.y + staffSpace);
  await expectSelected(page, { beat: 2, label: "E5", noteId: "p0-m1-n1-v0" });
});

test("clicking a rest selects the rest slot", async ({ page }) => {
  await loadSingleStaff(page);
  const c1 = await noteheadCenter(page, "#p0-m1-n1-v0"); // E5, beat 2
  const c2 = await noteheadCenter(page, "#p0-m1-n2-v0"); // G5, beat 3
  const beatSpan = c2.x - c1.x;

  // Select G5 first to show the selection then moves to the rest.
  await page.mouse.click(c2.x, c2.y);
  await expectSelected(page, { beat: 3, label: "G5", noteId: "p0-m1-n2-v0" });

  // Beat 4 is a quarter rest with no notehead. A click there snaps to the rest's
  // spine slot and selects it — no note is tinted, but the rest is now selected.
  await page.mouse.click(c2.x + beatSpan, c2.y);
  await expectRestSelected(page, { beat: 4, duration: "quarter" });
});
