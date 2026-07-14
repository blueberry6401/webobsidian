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

// Serve the generated HTML as its own document (not JSON) so the viewer <iframe> can
// use `src=` instead of `srcDoc=`. This matters because a `srcDoc` iframe inherits the
// embedding page's CSP (script-src 'self'+nonce), which silently blocks the inline
// <script>/onclick the LLM writes — the accordion-style previews looked broken with no
// console error the user could see. A real navigation gets its own response headers, so
// we override CSP to allow inline script/style for just this document.
//
// SECURITY: this document is served on the app's own origin (required so the LLM's
// inline script can execute at all). The <iframe sandbox="allow-scripts"> (no
// allow-same-origin) isolates it from the app's session when loaded THAT way — but
// sandbox is an iframe-only *attribute*, so it does nothing if this URL is ever opened
// as a top-level navigation instead (copied out of the iframe, middle-clicked, etc.).
// Two independent layers guard against that:
//   1. Fetch Metadata headers (Sec-Fetch-Dest/-Site) reject same-origin-but-not-iframe
//      requests outright — but only when the client sends them (older/unusual clients
//      may not), so this alone is fail-open, not a hard boundary.
//   2. `Content-Security-Policy: sandbox allow-scripts` (a *response header*, unlike the
//      iframe attribute) forces the document into a browser-enforced opaque origin no
//      matter how it was requested — top-level nav included. An opaque origin can't send
//      this app's cookies on same-origin fetch()/XHR and can't reach the parent frame, so
//      even a malicious/compromised preview can't read or overwrite the vault via /api/*.
//      This is the real boundary; layer 1 is just an early, friendlier rejection.
htmlPreviewRouter.get(
  '/:id/raw',
  asyncHandler(async (req, res) => {
    const fetchDest = req.get('Sec-Fetch-Dest');
    const fetchSite = req.get('Sec-Fetch-Site');
    if ((fetchDest && fetchDest !== 'iframe') || (fetchSite && fetchSite !== 'same-origin')) {
      res.status(403).send('This document can only be opened inside WebObsidian.');
      return;
    }
    const record = await getPreview(req.params.id);
    if (!record || record.status !== 'done') {
      res.status(404).send('Not found');
      return;
    }
    const html = await getPreviewHtml(record.id);
    if (!html) {
      res.status(404).send('Not found');
      return;
    }
    res.setHeader(
      'Content-Security-Policy',
      "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src * data: blob:; font-src * data:; connect-src 'none'; frame-ancestors 'self'",
    );
    res.type('html').send(html);
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
