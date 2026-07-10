import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireApiKey } from '../middleware/apikey.js';
import * as vault from '../services/vault.js';
import { qmd } from '../services/search.js';
import { backlinksFor, buildLinkGraph } from '../services/links.js';
import { parseNote } from '../services/markdown.js';
import { applyEdit } from '../services/noteedit.js';

/**
 * Agent API (PRD FR-6) — REST surface for AI agents, authenticated by API key.
 * All note paths are vault-relative. Scopes: read / write / search.
 */
export const agentRouter = Router();

function reindex(rel?: string) {
  if (rel) void qmd.upsert(rel).catch(() => {});
  void buildLinkGraph().catch(() => {});
}

agentRouter.get('/health', (_req, res) => res.json({ ok: true, service: 'webobsidian-agent-api', version: 'v1' }));

// List notes
agentRouter.get(
  '/notes',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const all = await vault.listMarkdownFiles();
    const offset = Number(req.query.offset ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    res.json({ total: all.length, offset, limit, notes: all.slice(offset, offset + limit) });
  }),
);

// Read a note (path can contain slashes)
agentRouter.get(
  '/notes/*',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const content = await vault.readFileText(rel);
    const note = parseNote(rel, content);
    res.json({
      path: rel,
      content,
      title: note.title,
      frontmatter: note.frontmatter,
      tags: note.tags,
      links: note.links,
    });
  }),
);

// Create / update a note
agentRouter.put(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const content = typeof req.body?.content === 'string' ? req.body.content : '';
    await vault.writeFileText(rel, content);
    reindex(rel);
    res.json({ ok: true, path: rel });
  }),
);

// PATCH: append (creates if missing) HOẶC find/replace nguyên tử (PRD 1.8, FR-6).
// Body có field `find` → nhánh edit; không có → hành vi append cũ giữ nguyên 100%.
agentRouter.patch(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    const body: unknown = req.body;
    // Own-property check (không dùng `in`): body dạng mảng vẫn phải đi nhánh append cũ
    // dù `Array.prototype.find` tồn tại trên prototype chain.
    const hasField = (obj: unknown, key: string): boolean =>
      typeof obj === 'object' && obj !== null && Object.prototype.hasOwnProperty.call(obj, key);

    if (hasField(body, 'find')) {
      // --- Nhánh edit find/replace nguyên tử ---
      const { find, replace, replaceAll } = body as { find: unknown; replace: unknown; replaceAll?: unknown };
      if (hasField(body, 'append') || typeof find !== 'string' || find === '' || typeof replace !== 'string') {
        res.status(400).json({ error: 'invalid_body' });
        return;
      }
      if (!(await vault.exists(rel))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const content = await vault.readFileText(rel);
      const result = applyEdit(content, find, replace, replaceAll === true);
      if ('error' in result) {
        res.status(409).json(result.error === 'find_ambiguous' ? { error: result.error, count: result.count } : { error: result.error });
        return;
      }
      await vault.writeFileText(rel, result.content);
      reindex(rel);
      res.json({ ok: true, path: rel, replaced: result.replaced });
      return;
    }

    // --- Nhánh append cũ (không đổi) ---
    const append = typeof req.body?.append === 'string' ? req.body.append : '';
    const existing = (await vault.exists(rel)) ? await vault.readFileText(rel) : '';
    const joined = existing && !existing.endsWith('\n') ? existing + '\n' + append : existing + append;
    await vault.writeFileText(rel, joined);
    reindex(rel);
    res.json({ ok: true, path: rel, size: joined.length });
  }),
);

// Delete a note (to trash)
agentRouter.delete(
  '/notes/*',
  requireApiKey('write'),
  asyncHandler(async (req, res) => {
    const rel = decodeURIComponent((req.params as any)[0]);
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const trashed = await vault.trash(rel);
    qmd.remove(rel);
    reindex();
    res.json({ ok: true, trashed });
  }),
);

// Search
agentRouter.get(
  '/search',
  requireApiKey('search'),
  asyncHandler(async (req, res) => {
    const q = String(req.query.q ?? '');
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    res.json({ query: q, hits: await qmd.search(q, limit) });
  }),
);

// Backlinks
agentRouter.get(
  '/backlinks',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    res.json({ path: rel, backlinks: backlinksFor(rel) });
  }),
);

// Tags
agentRouter.get(
  '/tags',
  requireApiKey('read'),
  asyncHandler(async (_req, res) => {
    res.json({ tags: qmd.allTags() });
  }),
);
