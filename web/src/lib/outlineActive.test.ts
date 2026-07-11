import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveHeading, getActiveHeading, subscribeActiveHeading } from './outlineActive';

beforeEach(() => setActiveHeading(-1));

describe('outlineActive store', () => {
  it('lưu và trả về index hiện tại', () => {
    setActiveHeading(3);
    expect(getActiveHeading()).toBe(3);
  });

  it('gọi subscriber khi đổi, bỏ qua khi trùng', () => {
    let calls = 0;
    let last = -99;
    const un = subscribeActiveHeading((i) => { calls++; last = i; });
    setActiveHeading(2);
    setActiveHeading(2); // trùng → no-op
    setActiveHeading(5);
    expect(calls).toBe(2);
    expect(last).toBe(5);
    un();
    setActiveHeading(7);
    expect(calls).toBe(2); // đã unsubscribe
  });
});
