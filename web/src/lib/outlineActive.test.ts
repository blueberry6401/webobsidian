import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveHeading, getActiveHeading, subscribeActiveHeading, pinActiveHeading } from './outlineActive';

beforeEach(() => pinActiveHeading(-1, 0));

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

  it('pin chặn scroll-spy ghi đè trong thời gian ghim', () => {
    pinActiveHeading(4, 10_000); // ghim lâu
    setActiveHeading(1); // scroll-spy cố ghi đè → bị chặn
    expect(getActiveHeading()).toBe(4);
    pinActiveHeading(4, 0); // gỡ ghim
    setActiveHeading(1); // giờ cập nhật được
    expect(getActiveHeading()).toBe(1);
  });
});
