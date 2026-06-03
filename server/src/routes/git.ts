import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as git from '../services/git.js';

export const gitRouter = Router();
gitRouter.use(requireAuth);

gitRouter.get('/status', asyncHandler(async (_req, res) => res.json(await git.status())));

gitRouter.post(
  '/init',
  asyncHandler(async (_req, res) => {
    await git.init();
    res.json(await git.status());
  }),
);

gitRouter.post(
  '/clone',
  asyncHandler(async (_req, res) => {
    await git.clone();
    res.json(await git.status());
  }),
);

gitRouter.post('/pull', asyncHandler(async (_req, res) => res.json({ message: await git.pull() })));

gitRouter.post(
  '/commit',
  asyncHandler(async (req, res) => {
    res.json({ message: await git.commitAll(String(req.body?.message ?? '')) });
  }),
);

gitRouter.post('/push', asyncHandler(async (_req, res) => res.json({ message: await git.push() })));

gitRouter.post(
  '/sync',
  asyncHandler(async (req, res) => {
    res.json(await git.sync(req.body?.message));
  }),
);
