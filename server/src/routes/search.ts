import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { qmd } from '../services/search.js';
import { backlinksFor, graphData, resolveLink, buildLinkGraph } from '../services/links.js';

export const searchRouter = Router();
searchRouter.use(requireAuth);

searchRouter.get(
  '/search',
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Number(req.query.limit ?? 30) || 30, 100);
    res.json({ query: q, hits: await qmd.search(q, limit) });
  }),
);

searchRouter.get(
  '/tags',
  asyncHandler(async (_req, res) => {
    res.json({ tags: qmd.allTags() });
  }),
);

searchRouter.get(
  '/backlinks',
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    res.json({ path: rel, backlinks: backlinksFor(rel) });
  }),
);

searchRouter.get(
  '/resolve',
  asyncHandler(async (req, res) => {
    const target = String(req.query.target ?? '');
    res.json({ target, path: resolveLink(target) ?? null });
  }),
);

searchRouter.get(
  '/graph',
  asyncHandler(async (_req, res) => {
    res.json(graphData());
  }),
);

searchRouter.post(
  '/reindex',
  asyncHandler(async (_req, res) => {
    await qmd.build();
    await buildLinkGraph();
    res.json({ ok: true });
  }),
);
