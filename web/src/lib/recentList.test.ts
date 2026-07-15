import { describe, it, expect } from 'vitest';
import { filterAndSortRecent, type RecentItem } from './recentList';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const items: RecentItem[] = [
  { path: 'a.md', time: NOW - 1 * DAY_MS }, // 1 day ago
  { path: 'b.md', time: NOW - 20 * DAY_MS }, // 20 days ago
  { path: 'c.md', time: NOW - 60 * DAY_MS }, // 60 days ago
  { path: 'd.md', time: NOW - 200 * DAY_MS }, // 200 days ago
];

describe('filterAndSortRecent', () => {
  it('week keeps only items from the last 7 days', () => {
    expect(filterAndSortRecent(items, 'week', NOW).map((i) => i.path)).toEqual(['a.md']);
  });
  it('month keeps items from the last 30 days, newest first', () => {
    expect(filterAndSortRecent(items, 'month', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md']);
  });
  it('3months keeps items from the last 90 days', () => {
    expect(filterAndSortRecent(items, '3months', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });
  it('all keeps everything, sorted newest first', () => {
    expect(filterAndSortRecent(items, 'all', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });
  it('returns an empty array for empty input', () => {
    expect(filterAndSortRecent([], 'all', NOW)).toEqual([]);
  });
});
