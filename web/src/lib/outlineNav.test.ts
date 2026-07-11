import { describe, it, expect } from 'vitest';
import { pickActiveHeading, ancestorIndices } from './outlineNav';

describe('pickActiveHeading', () => {
  const tops = [0, 100, 250, 400]; // top px mỗi heading (tăng dần)
  it('trả về heading đầu khi chưa cuộn', () => {
    expect(pickActiveHeading(tops, 0, 40)).toBe(0);
  });
  it('chọn heading gần nhất phía trên mốc scrollTop+margin', () => {
    expect(pickActiveHeading(tops, 120, 40)).toBe(1); // 160 ≥ 100, < 250
    expect(pickActiveHeading(tops, 220, 40)).toBe(2); // 260 ≥ 250
  });
  it('trả -1 khi rỗng', () => {
    expect(pickActiveHeading([], 0, 40)).toBe(-1);
  });
});

describe('ancestorIndices', () => {
  // levels: H1, H2, H3, H2, H1, H2
  const levels = [1, 2, 3, 2, 1, 2];
  it('trả các tổ tiên cấp nhỏ hơn (deepest-first)', () => {
    // target = index 2 (H3): tổ tiên là index 1 (H2), index 0 (H1)
    expect(ancestorIndices(levels, 2)).toEqual([1, 0]);
  });
  it('không có tổ tiên cho heading cấp cao nhất', () => {
    expect(ancestorIndices(levels, 4)).toEqual([]); // H1
  });
  it('bỏ qua sibling cùng/lớn hơn cấp', () => {
    expect(ancestorIndices(levels, 5)).toEqual([4]); // H2 → chỉ H1 index 4
  });
});
