import { useEffect, useRef, useState } from "preact/hooks";
import {
  type Color,
  compositeMasks,
  type OverlayLayer,
} from "../../lib/segmentation/overlay";
import type {
  Mask,
  RgbaImage,
  SegmentationMasks,
  StaffStructure,
} from "../../lib/types";

/**
 * Draws the recognition result: the page with the detected segmentation masks
 * overlaid in color and the Phase 2 staff structure (five-line staves and their
 * bounding boxes) stroked on top, plus a checkbox per layer to toggle each on
 * and off. This is the visual acceptance for Phases 1–2 — proof the UNets ran,
 * located the music, and that the staves were recovered from the staff mask.
 */

// Stroke colors for the staff overlay, distinct from the mask hues above.
const STAFF_BOX_COLOR = "rgba(236, 72, 153, 0.9)";
const STAFF_LINE_COLOR = "rgba(14, 165, 233, 0.9)";

interface LayerConfig {
  key: keyof SegmentationMasks;
  label: string;
  color: Color;
}

// Distinct hues so overlapping detections stay legible.
const LAYERS: LayerConfig[] = [
  { key: "staff", label: "Stafflines", color: [37, 99, 235] },
  { key: "noteheads", label: "Noteheads", color: [220, 38, 38] },
  { key: "stemsRests", label: "Stems / rests", color: [22, 163, 74] },
  { key: "clefsKeys", label: "Clefs / keys", color: [217, 119, 6] },
  { key: "symbols", label: "All symbols", color: [147, 51, 234] },
];

interface SegmentationViewProps {
  image: RgbaImage;
  masks: SegmentationMasks;
  staves: StaffStructure;
}

export function SegmentationView({
  image,
  masks,
  staves,
}: SegmentationViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [enabled, setEnabled] = useState<Record<string, boolean>>({
    staff: true,
    noteheads: true,
    stemsRests: false,
    clefsKeys: false,
    symbols: false,
  });
  const [showStaves, setShowStaves] = useState(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) {
      return;
    }
    const context = canvas.getContext("2d");
    if (context === null) {
      return;
    }
    const layers: OverlayLayer[] = LAYERS.filter(
      (layer) => enabled[layer.key],
    ).map((layer) => ({
      mask: masks[layer.key] as Mask,
      color: layer.color,
    }));
    const composited = compositeMasks(image, layers);
    canvas.width = composited.width;
    canvas.height = composited.height;
    const imageData = context.createImageData(
      composited.width,
      composited.height,
    );
    imageData.data.set(composited.data);
    context.putImageData(imageData, 0, 0);

    if (showStaves) {
      drawStaves(context, staves);
    }
  }, [image, masks, staves, enabled, showStaves]);

  return (
    <div class="segmentation-view">
      <p class="segmentation-view__summary">
        {staves.staves.length} stave{staves.staves.length === 1 ? "" : "s"}{" "}
        detected · unit size {staves.unitSize.toFixed(1)} px
      </p>
      <div class="segmentation-view__legend">
        {LAYERS.map((layer) => (
          <label key={layer.key} class="segmentation-view__toggle">
            <input
              type="checkbox"
              checked={enabled[layer.key]}
              onChange={(event) => {
                const checked = (event.currentTarget as HTMLInputElement)
                  .checked;
                setEnabled((current) => ({ ...current, [layer.key]: checked }));
              }}
            />
            <span
              class="segmentation-view__swatch"
              style={`background:rgb(${layer.color.join(",")})`}
            />
            {layer.label}
          </label>
        ))}
        <label class="segmentation-view__toggle">
          <input
            type="checkbox"
            checked={showStaves}
            onChange={(event) => {
              setShowStaves((event.currentTarget as HTMLInputElement).checked);
            }}
          />
          <span
            class="segmentation-view__swatch"
            style={`background:${STAFF_BOX_COLOR}`}
          />
          Staves
        </label>
      </div>
      <canvas ref={canvasRef} class="segmentation-view__canvas" />
    </div>
  );
}

/** Stroke each detected staff's bounding box and its five stafflines. */
function drawStaves(
  context: CanvasRenderingContext2D,
  staves: StaffStructure,
): void {
  context.lineWidth = 1;
  for (const staff of staves.staves) {
    const top = staff.lines[0];
    const bottom = staff.lines[staff.lines.length - 1];

    context.strokeStyle = STAFF_BOX_COLOR;
    context.strokeRect(staff.left, top, staff.right - staff.left, bottom - top);

    context.strokeStyle = STAFF_LINE_COLOR;
    context.beginPath();
    for (const line of staff.lines) {
      // Offset by half a pixel so the 1px stroke lands on the pixel row.
      context.moveTo(staff.left, line + 0.5);
      context.lineTo(staff.right, line + 0.5);
    }
    context.stroke();
  }
}
