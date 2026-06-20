/**
 * Renders a MusicXML string via OpenSheetMusicDisplay and provides a download
 * button so the user can save the `.musicxml` file. The OSMD canvas is
 * re-rendered whenever the `musicXml` prop changes.
 */
import { useEffect, useRef } from "preact/hooks";
import { OpenSheetMusicDisplay } from "opensheetmusicdisplay";

interface ScoreViewProps {
  musicXml: string;
  fileName?: string;
}

export function ScoreView({
  musicXml,
  fileName = "score.musicxml",
}: ScoreViewProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) {
      return;
    }
    const osmd = new OpenSheetMusicDisplay(container, {
      autoResize: false,
      drawTitle: false,
      drawComposer: false,
    });
    let cancelled = false;
    osmd
      .load(musicXml)
      .then(() => {
        if (!cancelled) {
          osmd.render();
        }
      })
      .catch((error) => {
        if (!cancelled) {
          console.error("[ScoreView] OSMD render failed:", error);
        }
      });
    return () => {
      cancelled = true;
      osmd.clear();
    };
  }, [musicXml]);

  function handleDownload() {
    const blob = new Blob([musicXml], {
      type: "application/vnd.recordare.musicxml+xml",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div class="score-view">
      <div class="score-view__toolbar">
        <button
          type="button"
          class="score-view__download"
          onClick={handleDownload}
        >
          Download .musicxml
        </button>
      </div>
      <div ref={containerRef} class="score-view__canvas" />
    </div>
  );
}
