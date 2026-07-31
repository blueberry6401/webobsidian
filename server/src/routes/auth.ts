import express, { Router, type Request } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth, resolveCookieSecure } from '../middleware/auth.js';
import {
  isPasswordSet,
  hasCustomPassword,
  setUserPassword,
  checkPassword,
  changePassword,
  issueToken,
  MIN_PASSWORD_LEN,
} from '../services/auth.js';
import { loginRateLimit } from '../middleware/ratelimit.js';

export const authRouter = Router();

// Every body here is just one or two password fields — a couple KB is ample.
const authJson = express.json({ limit: '2kb' });

function cookieOpts(req: Request) {
  return {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: resolveCookieSecure(req),
    maxAge: 30 * 24 * 60 * 60 * 1000,
    path: '/',
  };
}

authRouter.get(
  '/status',
  asyncHandler(async (_req, res) => {
    // mustChangePassword=true ⇒ still on the default 123456; the UI forces a change.
    res.json({ passwordSet: await isPasswordSet(), mustChangePassword: !(await hasCustomPassword()) });
  }),
);

authRouter.post(
  '/setup',
  authJson,
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
    await setUserPassword(password);
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  authJson,
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body ?? {};
    if (typeof currentPassword !== 'string' || typeof newPassword !== 'string') {
      res.status(400).json({ error: 'currentPassword and newPassword required' });
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LEN) {
      res.status(400).json({ error: `Password must be at least ${MIN_PASSWORD_LEN} characters` });
      return;
    }
    try {
      await changePassword(currentPassword, newPassword);
    } catch {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }
    // changePassword() rotates the session-signing secret, invalidating every
    // owner token issued before now (all devices/tabs). Re-issue a fresh one so
    // the request that just changed the password isn't logged out too.
    const token = await issueToken();
    res.cookie(COOKIE_NAME, token, cookieOpts(req)).json({ ok: true });
  }),
);

authRouter.post(
  '/login',
  loginRateLimit,
  authJson,
  asyncHandler(async (req, res) => {
    const { password } = req.body ?? {};
    if (typeof password !== 'string' || !(await checkPassword(password))) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }
    const token = await issueToken();
    res
      .cookie(COOKIE_NAME, token, cookieOpts(req))
      .json({ ok: true, mustChangePassword: !(await hasCustomPassword()) });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(COOKIE_NAME, { path: '/' }).json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (_req, res) => {
    res.json({ authenticated: true, mustChangePassword: !(await hasCustomPassword()) });
  }),
);
