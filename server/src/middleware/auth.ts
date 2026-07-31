import type { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/auth.js';

export const COOKIE_NAME = 'webobsidian_token';

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force. Shared by every
// route that sets a cookie (owner session, share unlock) so they stay consistent.
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

export function resolveCookieSecure(req: Request): boolean {
  return COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : req.secure;
}

/** Require a valid session cookie for web/session routes. */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = req.cookies?.[COOKIE_NAME] || bearer(req);
  if (token && (await verifyToken(token))) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}

function bearer(req: Request): string | undefined {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7);
  return undefined;
}
