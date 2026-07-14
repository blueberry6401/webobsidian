/** Lowercase, strip Vietnamese diacritics (incl. đ/Đ) and whitespace — for filename filtering. */
export function normalizeForFilter(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '');
}

/**
 * True if `text` contains `query` once both are normalized (diacritic/space/case-insensitive).
 * An empty (or whitespace-only) query matches everything.
 */
export function matchesQuery(text: string, query: string): boolean {
  const q = normalizeForFilter(query);
  if (!q) return true;
  return normalizeForFilter(text).includes(q);
}
