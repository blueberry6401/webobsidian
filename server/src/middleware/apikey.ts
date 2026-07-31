import type { Request, Response, NextFunction } from 'express';
import { authenticateKey, type Scope } from '../services/apikeys.js';
import { getSettings } from '../services/settings.js';
import type { ApiKeyRecord } from '../services/settings.js';
import { createSlidingWindowCounter } from '../lib/slidingwindow.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      apiKey?: ApiKeyRecord;
    }
  }
}

// Sliding-window rate limiter, keyed per API key id.
const rateOk = createSlidingWindowCounter(60_000);

function extractKey(req: Request): string {
  const xkey = req.headers['x-api-key'];
  if (typeof xkey === 'string' && xkey) return xkey;
  const auth = req.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

/** Guard for /api/v1 agent routes; optionally enforce a required scope. */
export function requireApiKey(scope?: Scope) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const raw = extractKey(req);
    const record = await authenticateKey(raw);
    if (!record) {
      res.status(401).json({ error: 'Invalid or missing API key' });
      return;
    }
    const s = await getSettings();
    if (!rateOk(record.id, s.api.rateLimitPerMin)) {
      res.status(429).json({ error: 'Rate limit exceeded' });
      return;
    }
    if (scope && !record.scopes.includes(scope)) {
      res.status(403).json({ error: `Missing scope: ${scope}` });
      return;
    }
    req.apiKey = record;
    // lightweight audit log (no secrets)
    console.log(`[api] ${record.name} ${req.method} ${req.path}`);
    next();
  };
}
