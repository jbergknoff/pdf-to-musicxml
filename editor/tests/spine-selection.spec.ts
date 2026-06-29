import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, type Page, test } from "@playwright/test";

// Integration tests for slot-based (spine) selection: selection is a *position*
// on the rhythm spine — a chord OR a rest — so ←/→ walks every slot (rests and
// empty measures included), and a rest can be turned into a note by typing a
// letter. This is what makes a staff with no notes (a blank document, or a gap)
// editable.

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

// The first measure's note/rest run, each note as "<step><octave>" and each rest
// as "REST" (same shape as editing-flows.spec's helper).
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

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("svg").first()).toBeVisible();
});

test("→ walks rest slots across empty measures", async ({ page }) => {
  // The blank document is four empty measures (a whole rest each). ← / → must
  // visit every one, even though none holds a note.
  const aside = page.locator("aside");
  for (let measure = 1; measure <= 4; measure++) {
    await page.keyboard.press("ArrowRight");
    await expect(aside.getByText(`Measure ${measure} · Beat 1`)).toBeVisible();
    await expect(aside.getByText("Rest · whole")).toBeVisible();
  }

  // → at the last slot clamps (stays on measure 4); ← steps back.
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByText("Measure 4 · Beat 1")).toBeVisible();
  await page.keyboard.press("ArrowLeft");
  await expect(aside.getByText("Measure 3 · Beat 1")).toBeVisible();
});

test("→ reaches the trailing rest of an imported measure", async ({ page }) => {
  await page.locator('input[type="file"]').setInputFiles(SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  const aside = page.locator("aside");

  // C5(beat1) E5(beat2) G5(beat3) then a quarter REST(beat4).
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByText("Measure 1 · Beat 1")).toBeVisible();
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByText("Measure 1 · Beat 3")).toBeVisible();

  // The 4th slot is the rest — note-only navigation would have stopped at G5.
  await page.keyboard.press("ArrowRight");
  await expect(aside.getByText("Measure 1 · Beat 4")).toBeVisible();
  await expect(aside.getByText("Rest · quarter")).toBeVisible();
});

test("clicking a rest then typing a letter inserts a quarter note there", async ({
  page,
}) => {
  await page.locator('input[type="file"]').setInputFiles(SINGLE_STAFF);
  await expect(page.locator("#p0-m1-n0-v0")).toBeVisible();
  expect(noteSequence(await exportXml(page))).toEqual([
    "C5",
    "E5",
    "G5",
    "REST",
  ]);

  // Click the beat-4 rest (no notehead), one beat-spacing right of G5.
  const c1 = await noteheadCenter(page, "#p0-m1-n1-v0");
  const c2 = await noteheadCenter(page, "#p0-m1-n2-v0");
  await page.mouse.click(c2.x + (c2.x - c1.x), c2.y);
  await expect(page.locator("aside").getByText("Rest · quarter")).toBeVisible();

  // Typing a letter fills the rest with a quarter note at that beat.
  await page.keyboard.press("a");
  const after = await exportXml(page);
  expect(noteSequence(after)).toEqual(["C5", "E5", "G5", "A4"]);
  expect(pitchCount(after)).toBe(4);
});

test("a melody can be built in a blank measure with letters and →", async ({
  page,
}) => {
  // Select measure 1's whole rest, then type a run of notes, advancing the
  // selection to the next (rest) slot between each.
  await page.keyboard.press("ArrowRight");
  await expect(
    page.locator("aside").getByText("Measure 1 · Beat 1"),
  ).toBeVisible();

  await page.keyboard.press("c");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("d");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("e");

  // Three quarter notes built from rests, with a quarter rest left at beat 4.
  const xml = await exportXml(page);
  expect(noteSequence(xml)).toEqual(["C5", "D5", "E5", "REST"]);
  expect(pitchCount(xml)).toBe(3);
});
