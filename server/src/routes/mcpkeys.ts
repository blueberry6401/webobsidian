import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { listKeys, createKey, revokeKey } from '../services/mcpkeys.js';

export const mcpKeysRouter = Router();
mcpKeysRouter.use(requireAuth);

mcpKeysRouter.get('/', asyncHandler(async (_req, res) => res.json({ keys: await listKeys() })));

mcpKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? 'MCP connection');
    const { raw, record } = await createKey(name);
    res.json({ key: raw, record }); // raw returned exactly once
  }),
);

mcpKeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await revokeKey(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  }),
);
