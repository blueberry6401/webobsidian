import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireApiKey } from '../middleware/apikey.js';
import * as vault from '../services/vault.js';
import { qmd } from '../services/search.js';
import { backlinksFor, buildLinkGraph } from '../services/links.js';
import { parseNote } from '../services/markdown.js';
import { applyEdit } from '../services/noteedit.js';
import { contentVersion } from '../services/noteversion.js';

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
    // The AI picks the order. Default = most-recently-modified first, so newly
    // touched notes never fall past the limit into an unread tail.
    const sort: vault.NoteSort =
      req.query.sort === 'name' || req.query.sort === 'created' ? req.query.sort : 'modified';
    const order: vault.SortOrder =
      req.query.order === 'asc' || req.query.order === 'desc'
        ? req.query.order
        : sort === 'name'
          ? 'asc'
          : 'desc';
    const all = await vault.listMarkdownFilesSorted(sort, order);
    const folderRaw = typeof req.query.folder === 'string' ? req.query.folder : '';
    const folder = folderRaw.replace(/^\/+|\/+$/g, '');
    const filtered = folder ? all.filter((p) => p === folder || p.startsWith(folder + '/')) : all;
    const offset = Number(req.query.offset ?? 0) || 0;
    const limit = Math.min(Number(req.query.limit ?? 100) || 100, 500);
    res.json({ total: filtered.length, offset, limit, sort, order, folder: folder || undefined, notes: filtered.slice(offset, offset + limit) });
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
    const version = contentVersion(content);
    const lines = content.split('\n');
    const totalLines = lines.length;
    const offset = Math.max(0, Number(req.query.offset ?? 0) || 0);
    const limit = Math.min(Math.max(1, Number(req.query.limit ?? 500) || 500), 2000);
    const slice = lines.slice(offset, offset + limit).join('\n');
    res.json({
      path: rel,
      content: slice,
      version,
      totalLines,
      offset,
      limit,
      hasMore: offset + limit < totalLines,
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
    const baseVersion = req.body?.base_version;
    if (typeof baseVersion !== 'string') {
      res.status(400).json({ error: 'missing_base_version' });
      return;
    }
    const existed = await vault.exists(rel);
    if (existed) {
      const current = contentVersion(await vault.readFileText(rel));
      if (baseVersion !== current) {
        res.status(409).json({ error: 'version_conflict', currentVersion: current });
        return;
      }
    } else if (baseVersion !== '') {
      res.status(409).json({ error: 'version_conflict', currentVersion: '' });
      return;
    }
    await vault.writeFileText(rel, content);
    reindex(rel);
    res.json({ ok: true, path: rel, version: contentVersion(content) });
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

// Grep trong 1 note: mọi vị trí khớp `q` (literal) kèm số dòng + ngữ cảnh (PRD FR-6).
// Query-param path (như /backlinks) để né bẫy thứ tự wildcard của /notes/*.
agentRouter.get(
  '/note-matches',
  requireApiKey('read'),
  asyncHandler(async (req, res) => {
    const rel = String(req.query.path ?? '');
    const q = String(req.query.q ?? '');
    if (!q) {
      res.status(400).json({ error: 'missing_query' });
      return;
    }
    if (!(await vault.exists(rel))) {
      res.status(404).json({ error: 'Not found' });
      return;
    }
    const caseSensitive = req.query.case_sensitive === 'true' || req.query.case_sensitive === '1';
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    const m = await qmd.matchesFor(rel, [q], { caseSensitive, maxContexts: limit });
    res.json({
      path: rel,
      query: q,
      count: m.count,
      matches: m.contexts.map((c) => ({ line: c.line ?? 1, text: c.text, ranges: c.ranges, pre: c.pre, post: c.post })),
    });
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
