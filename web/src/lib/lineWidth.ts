/**
 * Per-note line width ("readable line length" in Obsidian). Most notes read best
 * in a narrow column, but a note full of wide tables needs the whole screen — so
 * the width is a per-note setting toggled from the note header, not a global one.
 */

export type LineWidth = 'narrow' | 'wide' | 'full';

export const LINE_WIDTHS: LineWidth[] = ['narrow', 'wide', 'full'];

/** Value for `--file-line-width` (the max-width of the content column). */
export const LINE_WIDTH_CSS: Record<LineWidth, string> = {
  narrow: '700px',
  wide: '1100px',
  full: '100%',
};

export const LINE_WIDTH_LABEL: Record<LineWidth, string> = {
  narrow: 'Narrow',
  wide: 'Wide',
  full: 'Full width',
};

export const DEFAULT_LINE_WIDTH: LineWidth = 'narrow';

/** Only notes that differ from the default are stored; cap the map so it can't grow forever. */
const MAX_ENTRIES = 300;

export function nextLineWidth(mode: LineWidth): LineWidth {
  const i = LINE_WIDTHS.indexOf(mode);
  return LINE_WIDTHS[(i + 1) % LINE_WIDTHS.length];
}

export function lineWidthOf(map: Record<string, LineWidth>, path: string | null): LineWidth {
  return (path && map[path]) || DEFAULT_LINE_WIDTH;
}

/**
 * Set (or clear, when back to the default) one note's width. Newest entries win
 * when the map is trimmed — insertion order in a JS object is stable for string keys.
 */
export function setLineWidthEntry(
  map: Record<string, LineWidth>,
  path: string,
  mode: LineWidth,
): Record<string, LineWidth> {
  const next: Record<string, LineWidth> = { ...map };
  delete next[path];
  if (mode !== DEFAULT_LINE_WIDTH) next[path] = mode;
  const keys = Object.keys(next);
  if (keys.length > MAX_ENTRIES) {
    for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete next[k];
  }
  return next;
}

/** Drop anything that isn't a `path -> LineWidth` pair (persisted state is untrusted). */
export function sanitizeLineWidths(raw: unknown): Record<string, LineWidth> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, LineWidth> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k === 'string' && k && LINE_WIDTHS.includes(v as LineWidth) && v !== DEFAULT_LINE_WIDTH) {
      out[k] = v as LineWidth;
    }
  }
  return out;
}
