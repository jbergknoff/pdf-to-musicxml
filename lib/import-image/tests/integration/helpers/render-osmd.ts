/**
 * Browser-side OSMD rendering for the integration screenshot assertions.
 *
 * Renders a MusicXML string with OpenSheetMusicDisplay — the same library the
 * editor's ScoreView uses — into a fixed-width page, so the screenshot reflects
 * what a user actually sees. OSMD only needs a DOM (SVG output, no WebGL/WASM
 * and no cross-origin isolation), so a plain `page.setContent` harness suffices;
 * the heavy OMR inference already ran in Node before we get here.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";

// Resolve the prebuilt OSMD UMD bundle from node_modules regardless of where
// this file sits, then inline it into the page (no network, no CDN).
const require = createRequire(import.meta.url);
const OSMD_BUNDLE_PATH = require.resolve(
  "opensheetmusicdisplay/build/opensheetmusicdisplay.min.js",
);
const osmdBundle = readFileSync(OSMD_BUNDLE_PATH, "utf8");

/** Fixed render width (px). A fixed width makes OSMD's layout deterministic. */
const SCORE_WIDTH = 1100;

/**
 * Load OSMD into `page`, render `musicXml`, and resolve once the SVG is on the
 * page. The rendered score lives in `#score`; screenshot that element.
 */
export async function renderMusicXml(page: Page, musicXml: string): Promise<void> {
  await page.setViewportSize({ width: SCORE_WIDTH + 40, height: 1600 });
  await page.setContent(
    `<!doctype html><html><head><meta charset="utf-8"><style>
       html, body { margin: 0; padding: 0; background: #ffffff; }
       #score { width: ${SCORE_WIDTH}px; padding: 16px; background: #ffffff; }
     </style></head><body><div id="score"></div></body></html>`,
    { waitUntil: "load" },
  );
  await page.addScriptTag({ content: osmdBundle });

  await page.evaluate(async (xml) => {
    const osmdGlobal = (
      window as unknown as {
        opensheetmusicdisplay: {
          OpenSheetMusicDisplay: new (
            container: HTMLElement,
            options: Record<string, unknown>,
          ) => { load(xml: string): Promise<unknown>; render(): void };
        };
      }
    ).opensheetmusicdisplay;
    const container = document.getElementById("score");
    if (container === null) {
      throw new Error("score container missing");
    }
    const osmd = new osmdGlobal.OpenSheetMusicDisplay(container, {
      autoResize: false,
      drawTitle: false,
      drawComposer: false,
      drawingParameters: "compacttight",
    });
    await osmd.load(xml);
    osmd.render();
  }, musicXml);

  // OSMD renders into an <svg>; wait for it before screenshotting.
  await page.waitForSelector("#score svg", { state: "attached" });
}
