// Design tokens for the editor shell — the neutral pro-tool palette and type
// from the Claude Design handoff. Centralized so the toolbar, inspector,
// transport, and the renderer's accent/ink colors all draw from one source
// instead of the ad-hoc inline constants the editor used before.

export const COLORS = {
  // Accent (selection / active) + its tints.
  accent: "#2A6FDB",
  accentHighlight: "rgba(42,111,219,0.10)", // beat-box fill / focus ring fill
  accentRingFill: "rgba(42,111,219,0.12)", // note ring fill
  accentBorder: "rgba(42,111,219,0.55)", // beat-box border
  accentBorderFaint: "rgba(42,111,219,0.35)", // drilled (dashed) beat box

  // Playback.
  green: "#1F8A5B",
  greenCursorFill: "rgba(31,138,91,0.14)",
  greenCursorBorder: "rgba(31,138,91,0.6)",

  // Text ramp.
  textPrimary: "#2a2d30",
  textSecondary: "#54585c",
  textMuted: "#7c8186",
  textFaint: "#9aa0a6",
  textPlaceholder: "#b5babf",

  // Surfaces.
  canvas: "#ffffff",
  panel: "#fafbfc",
  appBg: "#eceef0",
  instructionStrip: "#eef4fd",

  // Borders.
  borderStructural: "#e0e3e6",
  borderLight: "#e4e6e8",
  borderButton: "#d7dadd",

  // Status.
  warning: "#8a6d3b",
  warningBg: "#fff8e1",
  warningBorder: "#f0e0a0",
  warningDot: "#f59e0b",
  error: "#c62828",
} as const;

export const RADIUS = {
  button: 6,
  row: 7,
  overlay: 6,
} as const;

export const FONTS = {
  ui: "'IBM Plex Sans', ui-sans-serif, system-ui, sans-serif",
  mono: "'IBM Plex Mono', ui-monospace, 'SF Mono', monospace",
  // The notation glyph font is registered separately by the renderer; this is
  // for the music symbols used as UI glyphs (♭ ♮ ♯) in the toolbar/inspector.
  music: "'Noto Music', 'IBM Plex Sans', sans-serif",
} as const;

// Focus-ring shadow for the drilled note's inspector row.
export const FOCUS_SHADOW = "0 0 0 3px rgba(42,111,219,.10)";

// Layout constants from the handoff.
export const LAYOUT = {
  toolbarHeight: 52,
  instructionStripHeight: 34,
  inspectorWidth: 288,
} as const;
