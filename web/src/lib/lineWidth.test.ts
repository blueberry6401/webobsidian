import { describe, it, expect } from 'vitest';
import {
  nextLineWidth,
  lineWidthOf,
  setLineWidthEntry,
  sanitizeLineWidths,
  type LineWidth,
} from './lineWidth';

describe('nextLineWidth', () => {
  it('quay vòng narrow → wide → full → narrow', () => {
    expect(nextLineWidth('narrow')).toBe('wide');
    expect(nextLineWidth('wide')).toBe('full');
    expect(nextLineWidth('full')).toBe('narrow');
  });
});

describe('lineWidthOf', () => {
  it('mặc định narrow khi note chưa có setting hoặc không có note', () => {
    expect(lineWidthOf({}, 'a.md')).toBe('narrow');
    expect(lineWidthOf({ 'a.md': 'full' }, null)).toBe('narrow');
  });

  it('trả về mức đã lưu của note', () => {
    expect(lineWidthOf({ 'a.md': 'wide' }, 'a.md')).toBe('wide');
  });
});

describe('setLineWidthEntry', () => {
  it('lưu mức khác mặc định và xoá entry khi quay lại narrow', () => {
    const withWide = setLineWidthEntry({}, 'a.md', 'wide');
    expect(withWide).toEqual({ 'a.md': 'wide' });
    expect(setLineWidthEntry(withWide, 'a.md', 'narrow')).toEqual({});
  });

  it('không đụng vào map cũ (immutable)', () => {
    const before = { 'a.md': 'wide' as LineWidth };
    setLineWidthEntry(before, 'b.md', 'full');
    expect(before).toEqual({ 'a.md': 'wide' });
  });

  it('giới hạn số entry, giữ lại các note vừa đặt gần nhất', () => {
    let map: Record<string, LineWidth> = {};
    for (let i = 0; i < 320; i++) map = setLineWidthEntry(map, `n${i}.md`, 'wide');
    expect(Object.keys(map)).toHaveLength(300);
    expect(map['n0.md']).toBeUndefined();
    expect(map['n319.md']).toBe('wide');
  });
});

describe('sanitizeLineWidths', () => {
  it('loại giá trị lạ, mảng, và entry narrow thừa', () => {
    expect(sanitizeLineWidths({ 'a.md': 'wide', 'b.md': 'huge', 'c.md': 'narrow', '': 'full' }))
      .toEqual({ 'a.md': 'wide' });
    expect(sanitizeLineWidths(['a.md'])).toEqual({});
    expect(sanitizeLineWidths(null)).toEqual({});
  });
});
