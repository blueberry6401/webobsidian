import { describe, it, expect } from 'vitest';
import { normalizeForFilter, matchesQuery } from './normalize';

describe('normalizeForFilter', () => {
  it('lowercases, strips Vietnamese diacritics and đ/Đ, removes whitespace', () => {
    expect(normalizeForFilter('Đà Nẵng')).toBe('danang');
    expect(normalizeForFilter('  Da   Nang  ')).toBe('danang');
    expect(normalizeForFilter('Hello World')).toBe('helloworld');
  });
  it('leaves already-plain ascii untouched apart from case/space', () => {
    expect(normalizeForFilter('Report.md')).toBe('report.md');
  });
});

describe('matchesQuery', () => {
  it('matches diacritic-insensitive, space-insensitive substrings', () => {
    expect(matchesQuery('Đà Nẵng.md', 'danang')).toBe(true);
    expect(matchesQuery('Đà Nẵng.md', 'da nang')).toBe(true);
    expect(matchesQuery('Đà Nẵng.md', 'DANANG')).toBe(true);
  });
  it('does not match unrelated names', () => {
    expect(matchesQuery('Đà Lạt.md', 'danang')).toBe(false);
  });
  it('empty (or whitespace-only) query matches everything', () => {
    expect(matchesQuery('anything.md', '')).toBe(true);
    expect(matchesQuery('anything.md', '   ')).toBe(true);
  });
});
