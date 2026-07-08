import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings, updateSettings } from '../services/settings.js';
import {
  listPreviews,
  getPreview,
  getPreviewHtml,
  createPreview,
  regeneratePreview,
  renamePreview,
  deletePreview,
  currentOutOfSync,
  type HtmlPreviewRecord,
} from '../services/htmlpreview.js';

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

async function toDto(r: HtmlPreviewRecord) {
  return { ...r, outOfSync: await currentOutOfSync(r) };
}

export const htmlPreviewRouter = Router();
htmlPreviewRouter.use(requireAuth);

htmlPreviewRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const notePath = String(req.query.notePath ?? '');
    if (!notePath) {
      res.status(400).json({ error: 'notePath required' });
      return;
    }
    const records = await listPreviews(notePath);
    res.json({ previews: await Promise.all(records.map(toDto)) });
  }),
);

htmlPreviewRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const notePath = String(req.body?.notePath ?? '');
    if (!notePath || !isMd(notePath)) {
      res.status(400).json({ error: 'notePath to a .md note required' });
      return;
    }
    if (!(await vault.exists(notePath))) {
      res.status(404).json({ error: 'note not found' });
      return;
    }
    const templateId = req.body?.templateId ? String(req.body.templateId) : null;
    let prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    let name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (templateId) {
      const s = await getSettings();
      const tpl = s.llm.templates.find((t) => t.id === templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template not found' });
        return;
      }
      prompt = tpl.prompt;
      if (!name) name = tpl.name;
    }
    if (!prompt) {
      res.status(400).json({ error: 'prompt or templateId required' });
      return;
    }
    if (!name) name = prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;

    const saveAsTemplate = req.body?.saveAsTemplate;
    if (saveAsTemplate && typeof saveAsTemplate.name === 'string' && saveAsTemplate.name.trim()) {
      await updateSettings((d) => {
        d.llm.templates.push({ id: randomBytes(8).toString('hex'), name: saveAsTemplate.name.trim(), prompt });
      });
    }

    const record = await createPreview({ notePath, templateId, prompt, name });
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const record = await getPreview(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    const html = record.status === 'done' ? await getPreviewHtml(record.id) : null;
    res.json({ preview: await toDto(record), html });
  }),
);

htmlPreviewRouter.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const record = await regeneratePreview(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const record = await renamePreview(req.params.id, name);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await deletePreview(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ ok: true });
  }),
);
