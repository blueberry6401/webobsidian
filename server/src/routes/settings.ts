import { Router } from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { getSettings, updateSettings, redactSettings } from '../services/settings.js';
import { config } from '../config.js';

export const settingsRouter = Router();
settingsRouter.use(requireAuth);

settingsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json(redactSettings(await getSettings()));
  }),
);

// Patch a subset of settings. Secret fields are only overwritten when present.
settingsRouter.put(
  '/',
  asyncHandler(async (req, res) => {
    const body = req.body ?? {};
    const updated = await updateSettings((d) => {
      if (body.vault) Object.assign(d.vault, sanitizeVault(body.vault));
      if (body.git) {
        const { token, ...rest } = body.git;
        Object.assign(d.git, rest);
        if (typeof token === 'string' && token && token !== '••••••••') d.git.token = token;
      }
      if (body.search) Object.assign(d.search, body.search);
      if (body.ui) Object.assign(d.ui, body.ui);
      if (body.api && typeof body.api.rateLimitPerMin === 'number') {
        d.api.rateLimitPerMin = body.api.rateLimitPerMin;
      }
    });
    res.json(redactSettings(updated));
  }),
);

function sanitizeVault(v: any) {
  const out: any = {};
  if (typeof v.path === 'string') out.path = v.path;
  if (typeof v.trash === 'string') out.trash = v.trash;
  if (typeof v.attachmentDir === 'string') out.attachmentDir = v.attachmentDir;
  if (Array.isArray(v.allowedRoots)) out.allowedRoots = v.allowedRoots;
  return out;
}

/** Safe folder browser for picking a vault path, limited to allowed roots. */
settingsRouter.get(
  '/browse',
  asyncHandler(async (req, res) => {
    const s = await getSettings();
    const roots = s.vault.allowedRoots.length
      ? s.vault.allowedRoots
      : config.allowedRoots.length
        ? config.allowedRoots
        : [os.homedir()];
    const dir = req.query.dir ? path.resolve(String(req.query.dir)) : roots[0];

    const allowed = roots.some((r) => {
      const rr = path.resolve(r);
      return dir === rr || dir.startsWith(rr + path.sep);
    });
    if (!allowed) {
      res.status(403).json({ error: 'Path outside allowed roots', roots });
      return;
    }
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ dir, parent: path.dirname(dir), roots, folders });
  }),
);
