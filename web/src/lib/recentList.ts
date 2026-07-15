export type RecentMode = 'opened' | 'created' | 'modified';
export type RecentRange = 'week' | 'month' | '3months' | 'all';

export interface RecentItem {
  path: string;
  time: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_MS: Record<Exclude<RecentRange, 'all'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  '3months': 90 * DAY_MS,
};

/** Keep items within `range` of `now`, newest first. `range === 'all'` keeps everything. */
export function filterAndSortRecent(items: RecentItem[], range: RecentRange, now = Date.now()): RecentItem[] {
  const cutoff = range === 'all' ? -Infinity : now - RANGE_MS[range];
  return items.filter((i) => i.time >= cutoff).sort((a, b) => b.time - a.time);
}
