import { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import { isPasswordSet, setPassword, checkPassword, issueToken } from '../services/auth.js';

export const authRouter = Router();

// A `Secure` cookie is silently dropped by browsers over plain http://, so tying
// it to NODE_ENV broke HTTP-only self-hosting (every API call 401'd → blank UI).
// Default 'auto' = match the request's actual transport (honours X-Forwarded-Proto
// via `trust proxy`); set COOKIE_SECURE=true/false to force.
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? 'auto').toLowerCase();

function cookieOpts(req: Request) {
  const secure =
    COOKIE_SECURE === 'true' ? true : COOKIE_SECURE === 'false' ? false : req.secure;
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure,
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    res.json({ passwordSet: await isPasswordSet() });
  }),
);

authRouter.post(
  '/setup',
  asyncHandler(async (req, res) => {
    if (await isPasswordSet()) {
      res.status(409).json({ error: 'Password already set' });
      return;
    }
    const { password } = req.body ?? {};
    if (typeof password !== 'string') {
      res.status(400).json({ error: 'password required' });
      return;
    }
    await setPassword(password);
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !(await checkPassword(password))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ authenticated: true });
  }),
);
