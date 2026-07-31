/**
 * Generic in-memory sliding-window counter, shared by every per-key rate
 * limiter (API keys, MCP keys). Each call site gets its own independent
 * counter map via a fresh call to `createSlidingWindowCounter`.
 */
export function createSlidingWindowCounter(windowMs: number): (key: string, max: number) => boolean {
  const hits = new Map<string, number[]>();
  return function rateOk(key: string, max: number): boolean {
    const now = Date.now();
    const windowStart = now - windowMs;
    const arr = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (arr.length >= max) {
      hits.set(key, arr);
      return false;
    }
    arr.push(now);
    hits.set(key, arr);
    return true;
  };
}
