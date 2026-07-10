import { describe, it, expect } from 'vitest';
import { computeHeadingKeys, type HeadingInfo } from './headingFold';

const h = (level: number, text: string): HeadingInfo => ({ level, text });

describe('computeHeadingKeys', () => {
  it('builds breadcrumb from ancestors by level', () => {
    const keys = computeHeadingKeys([h(1, 'A'), h(2, 'B'), h(3, 'C')]);
    expect(keys).toEqual(['A', 'A > B', 'A > B > C']);
  });

  it('resets ancestors when a higher-or-equal level appears', () => {
    const keys = computeHeadingKeys([h(2, 'X'), h(3, 'Y'), h(2, 'Z')]);
    expect(keys).toEqual(['X', 'X > Y', 'Z']);
  });

  it('suffixes duplicate breadcrumbs with #n by occurrence order', () => {
    const keys = computeHeadingKeys([h(1, 'A'), h(2, 'B'), h(1, 'A'), h(2, 'B')]);
    expect(keys).toEqual(['A', 'A > B', 'A#2', 'A#2 > B']);
  });

  it('handles a heading that skips levels (h1 then h4)', () => {
    const keys = computeHeadingKeys([h(1, 'A'), h(4, 'D')]);
    expect(keys).toEqual(['A', 'A > D']);
  });
});
