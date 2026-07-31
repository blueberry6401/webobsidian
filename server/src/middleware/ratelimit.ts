import type { Request, Response, NextFunction } from 'express';

/**
 * In-memory sliding-window brute-force guard. Single-process app (no DB), so
 * an in-memory map is sufficient; it resets on restart, which is fine for
 * throttling interactive guessing.
 */

// Key on the real TCP peer address, NOT req.ip. req.ip derives from
// X-Forwarded-For when `trust proxy` is enabled, which a directly-connected
// attacker can spoof per request to get a fresh bucket and bypass the limit
// (security report F-03). The socket address can't be forged at this layer,
// so the throttle holds regardless of how `trust proxy` is configured.
function clientIp(req: Request): string {
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Build a sliding-window rate-limit middleware. Each call gets its own bucket
 * map, so independent endpoints (login, per-share unlock) don't share limits.
 */
function slidingWindowLimit(opts: {
  windowMs: number;
  maxAttempts: number;
  keyFn: (req: Request) => string;
  message: string;
}): (req: Request, res: Response, next: NextFunction) => void {
  const attempts = new Map<string, number[]>();
  return (req, res, next) => {
    const key = opts.keyFn(req);
    const now = Date.now();
    const recent = (attempts.get(key) ?? []).filter((t) => t > now - opts.windowMs);
    if (recent.length >= opts.maxAttempts) {
      const retryAfter = Math.ceil((recent[0] + opts.windowMs - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: opts.message, retryAfter });
      return;
    }
    recent.push(now);
    attempts.set(key, recent);
    // Opportunistic cleanup so the map can't grow unbounded across many keys.
    if (attempts.size > 10_000) {
      for (const [k, v] of attempts) {
        if (v.every((t) => t <= now - opts.windowMs)) attempts.delete(k);
      }
    }
    next();
  };
}

export const loginRateLimit = slidingWindowLimit({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  keyFn: clientIp,
  message: 'Too many login attempts. Try again later.',
});

// Keyed on IP + share id (not just IP) so guessing across many shares from one
// address is throttled per-share, matching how an attacker with one leaked
// share link would actually operate.
export const shareUnlockRateLimit = slidingWindowLimit({
  windowMs: 15 * 60 * 1000,
  maxAttempts: 10,
  keyFn: (req) => `${clientIp(req)}:${req.params.id}`,
  message: 'Too many attempts. Try again later.',
});
