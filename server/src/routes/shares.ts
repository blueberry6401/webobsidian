import { Router } from 'express';
import type { Request } from 'express';
import { promises as fs } from 'node:fs';
import jwt from 'jsonwebtoken';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { resolveFile } from '../services/fileindex.js';
import { hashPassword, verifyPassword } from '../services/auth.js';
import { getSettings } from '../services/settings.js';
import {
  listShares, createShare, setShareEnabled, setSharePassword, setShareExpiry, deleteShare,
  getShareStatus, withinShareFolder, type ShareRecord,
} from '../services/shares.js';
import { canvasEmbedTargets } from '../services/rendercanvas.js';
import { mimeFor } from '../services/mime.js';
import { sendFileWithRange } from '../services/httpfile.js';

export const isMd = (p: string) => /\.(md|markdown)$/i.test(p);
export const isCanvas = (p: string) => /\.canvas$/i.test(p);

async function isShareable(p: string, kind: 'file' | 'folder'): Promise<boolean> {
  if (kind === 'folder') return vault.isDirectory(p);
  return isMd(p) || isCanvas(p);
}

/** Never send the password hash to the client — expose `hasPassword` only. */
function redact(rec: ShareRecord) {
  const { passwordHash, ...rest } = rec;
  return { ...rest, hasPassword: Boolean(passwordHash) };
}

/** ---- Management API (session auth) — /api/shares ------------------------- */

export const sharesRouter = Router();
sharesRouter.use(requireAuth);

sharesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ shares: (await listShares()).map(redact) });
  }),
);

sharesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const rel = String(req.body?.path ?? '');
    const kind: 'file' | 'folder' = req.body?.kind === 'folder' ? 'folder' : 'file';
    if (!rel || !(await isShareable(rel, kind))) {
      res.status(400).json({
        error: kind === 'folder' ? 'path to an existing folder required' : 'path to a .md or .canvas note required',
      });
      return;
    }
    res.json({ share: redact(await createShare(rel, kind)) });
  }),
);

// Update a share: { enabled?: boolean, password?: string | null, expiresAt?: string | null }.
// password: non-empty string sets it (scrypt-hashed); null/'' removes it.
// expiresAt: ISO timestamp sets it; null removes it (share never expires).
sharesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { enabled, password, expiresAt } = req.body ?? {};
    const hasEnabled = typeof enabled === 'boolean';
    const hasPassword = password !== undefined;
    const hasExpiresAt = expiresAt !== undefined;
    if (!hasEnabled && !hasPassword && !hasExpiresAt) {
      res.status(400).json({ error: 'enabled, password, or expiresAt required' });
      return;
    }
    if (hasPassword && password !== null && typeof password !== 'string') {
      res.status(400).json({ error: 'password must be a string or null' });
      return;
    }
    if (hasExpiresAt && expiresAt !== null && Number.isNaN(Date.parse(expiresAt))) {
      res.status(400).json({ error: 'expiresAt must be an ISO date string or null' });
      return;
    }
    let rec = hasEnabled ? await setShareEnabled(req.params.id, enabled) : null;
    if (hasPassword) {
      const hash = password ? await hashPassword(password) : null;
      rec = await setSharePassword(req.params.id, hash);
    }
    if (hasExpiresAt) {
      rec = await setShareExpiry(req.params.id, expiresAt);
    }
    if (!rec) {
      res.status(404).json({ error: 'share not found' });
      return;
    }
    res.json({ share: redact(rec) });
  }),
);

sharesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await deleteShare(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'share not found' });
      return;
    }
    res.json({ ok: true });
  }),
);

/** ---- Public API (NO auth) — /public/shares ------------------------------- */

/**
 * Files a file-kind shared note embeds (`![[target]]` and `![](relative-url)`) —
 * the only paths the public file endpoint may serve for that share.
 */
function embedTargets(content: string): string[] {
  const out = new Set<string>();
  for (const m of content.matchAll(/!\[\[([^\]]+?)\]\]/g)) {
    const t = m[1].split('|')[0].split('#')[0].trim();
    if (t) out.add(t);
  }
  for (const m of content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    const url = m[1].replace(/\s+"[^"]*"$/, '').trim();
    if (url && !/^(https?|data|blob|file):/i.test(url)) {
      out.add(decodeURIComponent(url.split('/').pop() || url));
    }
  }
  return [...out];
}

/** Resolve a path/basename the same way GET /api/files/content does. */
async function resolveVaultPath(rel: string): Promise<string | null> {
  if (await vault.exists(rel)) return rel;
  return resolveFile(rel) ?? null;
}

/**
 * Resolve `subpath` against a folder-kind share's root, refusing anything
 * outside `share.path`. Returns the vault-relative path, or null if the
 * resolved target escapes the shared folder (or doesn't exist).
 */
export async function resolveInShareFolder(share: ShareRecord, subpath: string): Promise<string | null> {
  const clean = subpath.replace(/^\/+/, '');
  const targetRel = clean ? `${share.path}/${clean}` : share.path;
  let abs: string;
  try {
    abs = await vault.resolveInVault(targetRel);
  } catch {
    return null;
  }
  const root = await vault.getVaultRoot();
  // Containment must be checked against the *realpath*, not the lexical path:
  // vault.resolveInVault already rejects a symlink that escapes the vault entirely,
  // but a symlink that lives inside the shared folder and points elsewhere *within*
  // the vault would still lexically start with the shared folder's prefix. Resolving
  // both sides through fs.realpath before comparing closes that gap.
  let real: string;
  let realRoot: string;
  try {
    [real, realRoot] = await Promise.all([fs.realpath(abs), fs.realpath(root).catch(() => root)]);
  } catch {
    return null; // target doesn't exist (or is unreadable) — nothing to serve
  }
  const rel = vault.toRel(realRoot, real);
  return withinShareFolder(share.path, rel) ? rel : null;
}

export const publicSharesRouter = Router();

const UNLOCK_TTL = '12h';
const unlockCookie = (id: string) => `wo_share_${id}`;

/** True when the share has no password, or the visitor carries a valid unlock cookie. */
export async function isUnlocked(req: Request, share: ShareRecord): Promise<boolean> {
  if (!share.passwordHash) return true;
  const token = req.cookies?.[unlockCookie(share.id)];
  if (!token) return false;
  try {
    const s = await getSettings();
    const payload = jwt.verify(token, s.auth.jwtSecret, { algorithms: ['HS256'] }) as {
      sub?: string;
      share?: string;
    };
    return payload.sub === 'share' && payload.share === share.id;
  } catch {
    return false;
  }
}

// Exchange the share password for an unlock cookie scoped to this share's
// public endpoints (httpOnly so embedded <img> requests send it automatically).
publicSharesRouter.post(
  '/:id/unlock',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    if (status.status !== 'active') {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const share = status.record;
    if (!share.passwordHash) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const password = String(req.body?.password ?? '');
    if (!password || !(await verifyPassword(password, share.passwordHash))) {
      res.status(401).json({ error: 'wrong password' });
      return;
    }
    const s = await getSettings();
    const token = jwt.sign({ sub: 'share', share: share.id }, s.auth.jwtSecret, {
      expiresIn: UNLOCK_TTL,
      algorithm: 'HS256',
    });
    // Path '/' so both /public/shares/<id>/* (content, files) AND the SSR page
    // at /share/<id>[/f] receive it. The JWT is bound to this share id only.
    res.cookie(unlockCookie(share.id), token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true });
  }),
);

publicSharesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    if (status.status !== 'active' || status.record.kind !== 'file' || !(await vault.exists(status.record.path))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const share = status.record;
    if (!(await isUnlocked(req, share))) {
      res.status(401).json({ error: 'password required', passwordRequired: true });
      return;
    }
    const title = (share.path.split('/').pop() ?? share.path).replace(/\.(md|markdown|canvas)$/i, '');
    // NOTE: only title + content — the vault path/structure is not exposed.
    res.json({ title, content: await vault.readFileText(share.path) });
  }),
);

publicSharesRouter.get(
  '/:id/file',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    const requested = String(req.query.path ?? '');
    if (status.status !== 'active' || !requested || !(await vault.exists(status.record.path))) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const share = status.record;
    if (!(await isUnlocked(req, share))) {
      res.status(401).json({ error: 'password required', passwordRequired: true });
      return;
    }
    let target: string | null = null;
    if (share.kind === 'folder') {
      // The whole folder was deliberately shared — any file inside it is servable,
      // not just embed targets (that allowlist is a file-kind-only restriction).
      // .md/.markdown/.canvas are excluded: those render through the SSR /f
      // note/canvas pipeline instead. Directories are excluded too — resolving a
      // subfolder here is a valid, in-bounds path but not a file, and streaming a
      // directory via createReadStream would hang the request (EISDIR).
      //
      // `requested` is normally already share-root-relative (folder listing
      // thumbnails/links, and the SSR media/download pages, all send that).
      // But note/canvas content rendered inside a shared folder can also embed a
      // bare basename (`![[photo.png]]`, resolved Obsidian-style against the
      // whole vault, possibly outside this subfolder) — resolveInShareFolder
      // alone would 404 that. Fall back to the same vault-wide resolution
      // file-kind shares use, but re-check containment: resolveVaultPath's
      // basename search is vault-wide, so without this the fallback could leak
      // a same-named file from outside the shared folder.
      //
      // The lexical `withinShareFolder` check alone isn't enough here: a
      // symlink that physically lives inside the shared folder but points to
      // a file elsewhere in the vault would lexically pass while its realpath
      // escapes the share. Re-run the candidate through resolveInShareFolder
      // (share-relative subpath) so it gets the same realpath-based
      // containment check the primary resolution already enforces.
      let resolved = await resolveInShareFolder(share, requested);
      if (!resolved) {
        const fallback = await resolveVaultPath(requested);
        if (fallback && withinShareFolder(share.path, fallback)) {
          const subpath = fallback === share.path ? '' : fallback.slice(share.path.length + 1);
          resolved = await resolveInShareFolder(share, subpath);
        }
      }
      target =
        resolved && !isMd(resolved) && !isCanvas(resolved) && !(await vault.isDirectory(resolved))
          ? resolved
          : null;
    } else {
      const resolved = await resolveVaultPath(requested);
      if (resolved && !isMd(resolved)) {
        // Allowlist check: the resolved file must be one the shared note/canvas embeds.
        const content = await vault.readFileText(share.path);
        const targets = isCanvas(share.path) ? await canvasEmbedTargets(content) : embedTargets(content);
        const allowed = new Set<string>();
        for (const t of targets) {
          const r = await resolveVaultPath(t);
          if (r) allowed.add(r);
        }
        if (allowed.has(resolved)) target = resolved;
      }
    }
    if (!target) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    // Stream with Range support so shared <video>/<audio> can seek.
    const abs = await vault.resolveInVault(target);
    await sendFileWithRange(req, res, abs, mimeFor(target), { 'Cache-Control': 'private, max-age=300' });
  }),
);
