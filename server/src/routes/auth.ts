import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { COOKIE_NAME, requireAuth } from '../middleware/auth.js';
import { isPasswordSet, setPassword, checkPassword, issueToken } from '../services/auth.js';
import { config } from '../config.js';

export const authRouter = Router();

const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: config.isProd,
  maxAge: 30 * 24 * 60 * 60 * 1000,
  path: '/',
};

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
    res.cookie(COOKIE_NAME, token, cookieOpts).json({ ok: true });
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
    res.cookie(COOKIE_NAME, token, cookieOpts).json({ ok: true });
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
