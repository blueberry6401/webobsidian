import express, { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { listKeys, createKey, revokeKey, setPermission } from '../services/mcpkeys.js';

export const mcpKeysRouter = Router();
mcpKeysRouter.use(requireAuth);
mcpKeysRouter.use(express.json({ limit: '8kb' }));

mcpKeysRouter.get('/', asyncHandler(async (_req, res) => res.json({ keys: await listKeys() })));

mcpKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? 'MCP connection');
    const permission = req.body?.permission === 'read' ? 'read' : 'write';
    const { raw, record } = await createKey(name, permission);
    res.json({ key: raw, record }); // raw returned exactly once
  }),
);

mcpKeysRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const p = req.body?.permission;
    if (p !== 'read' && p !== 'write') {
      res.status(400).json({ error: 'permission must be "read" or "write"' });
      return;
    }
    const ok = await setPermission(req.params.id, p);
    res.status(ok ? 200 : 404).json({ ok });
  }),
);

mcpKeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await revokeKey(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  }),
);
