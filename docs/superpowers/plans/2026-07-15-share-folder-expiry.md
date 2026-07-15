# Share thư mục + Share có thời hạn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the existing public-share feature (FR-10) so a whole vault folder can be shared read-only (server-rendered file browser, one page per level, no JS required) and every share (file or folder) can carry an optional expiry with 4 quick presets (1 day / 7 days / 30 days / no limit).

**Architecture:** `ShareRecord` gains `kind: 'file'|'folder'` and `expiresAt?: string|null`. A new central `getShareStatus(id)` in the shares service replaces `getActiveShare()` and returns `active | expired | not_found`, used by every public/SSR route. Folder browsing is pure SSR: `GET /share/:id` (root) and a new `GET /share/:id/f?path=<subpath>` render one directory level or one file per request — no client-side JS, matching the existing single-note share page's philosophy. All path resolution for folder browsing goes through the vault's existing traversal guard (`resolveInVault`) plus a new containment check (`withinShareFolder`).

**Tech Stack:** TypeScript, Express 4, Vitest (new for the `server` workspace, already used in `web`), React (only for the management dialog — the public pages are plain server-rendered HTML/CSS, no React).

## Global Constraints

- TypeScript for both `server` and `web`; avoid `any`.
- No new database engine — `data/shares.json` stays a flat JSON array, atomic tmp+rename writes.
- Never log secrets/tokens/API keys.
- Every new path resolution for public routes MUST go through `vault.resolveInVault` (or the new `resolveInShareFolder` wrapper built on it) — no manual string concatenation of vault paths.
- Commit after every task (this session has explicit user authorization to commit/push/deploy — see task 12).
- Match existing code style: no comments explaining *what* code does, only non-obvious *why*.
- `PRD.md` FR-10 and `IMPLEMENTATION_PLAN.md` Phase 33 are already updated with this design — keep them in sync if anything here changes during implementation (flip `[ ]` → `[x]` per milestone as you finish it, per this repo's `CLAUDE.md`).

---

### Task 1: Server-side Vitest setup

**Files:**
- Modify: `server/package.json`
- Modify: `server/tsconfig.json`
- Create: `server/vitest.config.ts`

**Interfaces:**
- Produces: `npm --workspace server run test` (runs `vitest run` against `src/**/*.test.ts`), available for Task 4.

- [ ] **Step 1: Add the `test` script and `vitest` devDependency to `server/package.json`**

Edit `server/package.json`:

```json
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "typecheck": "tsc -p tsconfig.json --noEmit",
    "test": "vitest run"
  },
```

And add to `devDependencies` (same version already pinned in `web/package.json`):

```json
    "vitest": "^2.1.9"
```

- [ ] **Step 2: Create `server/vitest.config.ts`** (mirrors `web/vitest.config.ts`)

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Exclude test files from the production `tsc` build**

`server/package.json`'s `build` script compiles the whole `src/` tree with real emit (`outDir: dist`) — unlike `web` (which uses `noEmit: true` and lets Vite's bundler drop unimported files), so `*.test.ts` would otherwise land in `dist/`. Edit `server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "esModuleInterop": true,
    "allowSyntheticDefaultImports": true,
    "strict": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true,
    "declaration": false,
    "forceConsistentCasingInFileNames": true,
    "lib": ["ES2022"],
    "types": ["node"]
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts"]
}
```

- [ ] **Step 4: Install the new dependency**

Run: `npm install` (repo root — this is an npm workspaces monorepo, so this pulls `vitest` into `server/node_modules` too)
Expected: exits 0, `package-lock.json` updated with `vitest` under the `server` workspace.

- [ ] **Step 5: Commit**

```bash
git add server/package.json server/tsconfig.json server/vitest.config.ts package-lock.json
git commit -m "test(server): add Vitest workspace (no tests yet)"
```

---

### Task 2: `vault.ts` — `isDirectory` + `listDir`, `mime.ts` — `IMAGE_EXT_RE`

**Files:**
- Modify: `server/src/services/vault.ts`
- Modify: `server/src/services/mime.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `vault.isDirectory(rel: string): Promise<boolean>`, `vault.listDir(rel: string): Promise<TreeNode[]>` (direct children only, folders-first-then-alphabetical, same sort as `listTree`), `IMAGE_EXT_RE: RegExp` from `mime.ts` — all consumed by Task 5 (routes/shares.ts) and Task 6 (sharepage.ts).

- [ ] **Step 1: Add `isDirectory` and `listDir` to `server/src/services/vault.ts`**

Insert right after `export async function exists(rel: string)` (currently ends around line 206):

```ts
export async function isDirectory(rel: string): Promise<boolean> {
  try {
    const st = await fs.stat(await resolveInVault(rel));
    return st.isDirectory();
  } catch {
    return false;
  }
}

/** List the direct children of a vault-relative folder — one level, not recursive. */
export async function listDir(rel: string): Promise<TreeNode[]> {
  const root = await getVaultRoot();
  const absDir = await resolveInVault(rel);
  const entries = await fs.readdir(absDir, { withFileTypes: true });
  const nodes = await Promise.all(
    entries
      .filter((e) => !(IGNORED.has(e.name) || e.name.startsWith('.')))
      .map(async (e): Promise<TreeNode | null> => {
        const abs = path.join(absDir, e.name);
        const r = toRel(root, abs);
        if (e.isDirectory()) return { name: e.name, path: r, type: 'folder' };
        if (e.isFile()) return { name: e.name, path: r, type: 'file', ext: path.extname(e.name).toLowerCase() };
        return null;
      }),
  );
  const out = nodes.filter((n): n is TreeNode => n !== null);
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}
```

This mirrors `listTree()`'s existing `walk()` sort convention (folders first, then alphabetical) so folder-share listings look identical to the in-app file tree order.

- [ ] **Step 2: Add `IMAGE_EXT_RE` to `server/src/services/mime.ts`**

Edit the bottom of the file:

```ts
export const VIDEO_EXT_RE = /\.(mp4|webm|ogv|mov|mkv)$/i;
export const AUDIO_EXT_RE = /\.(mp3|wav|m4a|3gp|flac|ogg|oga|opus)$/i;
export const IMAGE_EXT_RE = /\.(png|jpe?g|gif|svg|webp|bmp|avif|ico)$/i;
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace server run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/vault.ts server/src/services/mime.ts
git commit -m "feat(server): add vault.isDirectory/listDir + mime.IMAGE_EXT_RE for folder shares"
```

---

### Task 3: `shares.ts` service — `kind`, `expiresAt`, `getShareStatus` (TDD)

**Files:**
- Modify: `server/src/services/shares.ts`
- Test: `server/src/services/shares.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Task 5 routes):
  - `ShareRecord` now has `kind: 'file' | 'folder'` and `expiresAt?: string | null`.
  - `export function isExpired(expiresAt: string | null | undefined, now?: number): boolean`
  - `export function withinShareFolder(sharePath: string, rel: string): boolean`
  - `export function normalizeShareRecord(raw: unknown): ShareRecord | null`
  - `export type ShareStatus = { status: 'active'; record: ShareRecord } | { status: 'expired' } | { status: 'not_found' }`
  - `export async function getShareStatus(id: string): Promise<ShareStatus>` — replaces `getActiveShare` (removed).
  - `export async function createShare(relPath: string, kind?: 'file' | 'folder'): Promise<ShareRecord>` — `kind` defaults to `'file'`.
  - `export async function setShareExpiry(id: string, expiresAt: string | null): Promise<ShareRecord | null>`

- [ ] **Step 1: Write the failing tests** — `server/src/services/shares.test.ts`

Only the three pure helpers are unit-tested here (matches this repo's existing Vitest convention: `headingFold.test.ts`, `normalize.test.ts`, `recentList.test.ts` all test pure logic, not fs-backed I/O — the fs-backed CRUD functions are covered by manual E2E in Task 11, same as e.g. HTML Preview / Outline nav were).

```ts
import { describe, it, expect } from 'vitest';
import { isExpired, withinShareFolder, normalizeShareRecord } from './shares.js';

describe('isExpired', () => {
  it('returns false when expiresAt is unset', () => {
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(null)).toBe(false);
  });

  it('returns false when expiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isExpired(future)).toBe(false);
  });

  it('returns true when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isExpired(past)).toBe(true);
  });

  it('accepts an explicit now for deterministic tests', () => {
    const now = new Date('2026-01-02T00:00:00.000Z').getTime();
    expect(isExpired('2026-01-01T00:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-01-03T00:00:00.000Z', now)).toBe(false);
  });
});

describe('withinShareFolder', () => {
  it('matches the shared folder itself', () => {
    expect(withinShareFolder('Folder', 'Folder')).toBe(true);
  });

  it('matches a file nested inside the shared folder', () => {
    expect(withinShareFolder('Folder', 'Folder/Sub/note.md')).toBe(true);
  });

  it('rejects a sibling folder whose name merely starts with the same prefix', () => {
    expect(withinShareFolder('Folder', 'Folder2/note.md')).toBe(false);
  });

  it('rejects an unrelated path', () => {
    expect(withinShareFolder('Folder', 'Other/note.md')).toBe(false);
  });
});

describe('normalizeShareRecord', () => {
  it('defaults kind to file for records written before the field existed', () => {
    const rec = normalizeShareRecord({ id: 'a', path: 'Note.md', enabled: true, createdAt: '2026-01-01' });
    expect(rec?.kind).toBe('file');
  });

  it('preserves an explicit folder kind', () => {
    const rec = normalizeShareRecord({ id: 'a', path: 'Folder', kind: 'folder', enabled: true, createdAt: '2026-01-01' });
    expect(rec?.kind).toBe('folder');
  });

  it('rejects entries missing required fields', () => {
    expect(normalizeShareRecord({ id: 'a' })).toBeNull();
    expect(normalizeShareRecord(null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --workspace server run test`
Expected: FAIL — `shares.ts` doesn't export `isExpired`/`withinShareFolder`/`normalizeShareRecord` yet.

- [ ] **Step 3: Rewrite `server/src/services/shares.ts`**

Full replacement:

```ts
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { config } from '../config.js';

/** Public share links (FR-10) — persisted as a JSON array in data/shares.json. */
export interface ShareRecord {
  id: string;
  path: string; // vault-relative note or folder path
  kind: 'file' | 'folder';
  enabled: boolean;
  createdAt: string;
  /** ISO timestamp; unset/null = never expires. */
  expiresAt?: string | null;
  /** Optional scrypt hash — set when the share is password-protected. */
  passwordHash?: string;
}

const SHARES_FILE = path.join(config.dataDir, 'shares.json');

let cache: ShareRecord[] | null = null;

/** Validate a raw JSON entry and default `kind` for records written before it existed. */
export function normalizeShareRecord(raw: unknown): ShareRecord | null {
  const r = raw as Partial<ShareRecord> | null;
  if (!r || typeof r.id !== 'string' || typeof r.path !== 'string') return null;
  return { ...r, kind: r.kind === 'folder' ? 'folder' : 'file' } as ShareRecord;
}

/** True when `expiresAt` is set and in the past. */
export function isExpired(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  return now > new Date(expiresAt).getTime();
}

/** True when `rel` is the shared folder itself, or lives inside it. */
export function withinShareFolder(sharePath: string, rel: string): boolean {
  return rel === sharePath || rel.startsWith(`${sharePath}/`);
}

async function load(): Promise<ShareRecord[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(SHARES_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed)
      ? parsed.map(normalizeShareRecord).filter((r): r is ShareRecord => r !== null)
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

/** Atomic write: tmp + rename (same pattern as settings.json). */
async function persist(shares: ShareRecord[]): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
  const tmp = `${SHARES_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, JSON.stringify(shares, null, 2), { mode: 0o600 });
  await fs.rename(tmp, SHARES_FILE);
}

export async function listShares(): Promise<ShareRecord[]> {
  return [...(await load())];
}

export type ShareStatus =
  | { status: 'active'; record: ShareRecord }
  | { status: 'expired' }
  | { status: 'not_found' };

/** Central lookup for every public/SSR route: active, expired, or not found (disabled ≡ not found). */
export async function getShareStatus(id: string): Promise<ShareStatus> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec || !rec.enabled) return { status: 'not_found' };
  if (isExpired(rec.expiresAt)) return { status: 'expired' };
  return { status: 'active', record: rec };
}

/**
 * Create a share for a note or folder. One record per (path, kind): if it
 * already has a share, re-enable and return it (keeps the public URL stable).
 */
export async function createShare(relPath: string, kind: 'file' | 'folder' = 'file'): Promise<ShareRecord> {
  const shares = await load();
  const existing = shares.find((s) => s.path === relPath && s.kind === kind);
  if (existing) {
    if (!existing.enabled) {
      existing.enabled = true;
      await persist(shares);
    }
    return existing;
  }
  const record: ShareRecord = {
    id: randomBytes(16).toString('base64url'),
    path: relPath,
    kind,
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  shares.push(record);
  await persist(shares);
  return record;
}

export async function setShareEnabled(id: string, enabled: boolean): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (rec.enabled !== enabled) {
    rec.enabled = enabled;
    await persist(shares);
  }
  return rec;
}

/** Set (hash) or clear (null) the password of a share. */
export async function setSharePassword(id: string, passwordHash: string | null): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (passwordHash) rec.passwordHash = passwordHash;
  else delete rec.passwordHash;
  await persist(shares);
  return rec;
}

/** Set (ISO timestamp) or clear (null) the expiry of a share. */
export async function setShareExpiry(id: string, expiresAt: string | null): Promise<ShareRecord | null> {
  const shares = await load();
  const rec = shares.find((s) => s.id === id);
  if (!rec) return null;
  if (expiresAt) rec.expiresAt = expiresAt;
  else delete rec.expiresAt;
  await persist(shares);
  return rec;
}

export async function deleteShare(id: string): Promise<boolean> {
  const shares = await load();
  const next = shares.filter((s) => s.id !== id);
  if (next.length === shares.length) return false;
  cache = next;
  await persist(next);
  return true;
}

/** Keep share paths in sync when notes/folders are renamed/deleted elsewhere. */
export async function onFileRenamed(from: string, to: string): Promise<void> {
  const shares = await load();
  const rec = shares.find((s) => s.path === from);
  if (rec) {
    rec.path = to;
    await persist(shares);
  }
}
```

Note: `getActiveShare` is intentionally removed — Task 4 updates its 4 call sites (3 in `routes/shares.ts`, 1 in `routes/sharepage.ts`) to use `getShareStatus` instead. The codebase will not compile between this step and Task 4; that's expected — finish Task 4 in the same session before running a full typecheck.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --workspace server run test`
Expected: PASS — 11 tests across the 3 `describe` blocks.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/shares.ts server/src/services/shares.test.ts
git commit -m "feat(server): shares.ts kind/expiresAt + getShareStatus (replaces getActiveShare)"
```

---

### Task 4: `routes/shares.ts` — management API + public API

**Files:**
- Modify: `server/src/routes/shares.ts`

**Interfaces:**
- Consumes: `getShareStatus`, `createShare(relPath, kind)`, `setShareExpiry`, `withinShareFolder` from `../services/shares.js` (Task 3); `vault.isDirectory` from `../services/vault.js` (Task 2).
- Produces (consumed by Task 5 `sharepage.ts`): `export const isMd`, `export const isCanvas`, `export async function resolveInShareFolder(share, subpath): Promise<string | null>`, `export async function isUnlocked(req, share): Promise<boolean>` (unchanged signature, kept).

- [ ] **Step 1: Full replacement of `server/src/routes/shares.ts`**

```ts
import { Router } from 'express';
import type { Request } from 'express';
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
  const rel = vault.toRel(root, abs);
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
    if (status.status !== 'active' || !status.record.passwordHash) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    const share = status.record;
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
      const resolved = await resolveInShareFolder(share, requested);
      target = resolved && !isMd(resolved) ? resolved : null;
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
```

- [ ] **Step 2: Typecheck**

Run: `npm --workspace server run typecheck`
Expected: still FAILS at this point — `server/src/routes/sharepage.ts` still imports the now-deleted `getActiveShare` from `../services/shares.js`. That's fixed in Task 5. Confirm the *only* remaining error mentions `sharepage.ts`/`getActiveShare` (i.e. `routes/shares.ts` itself compiles clean).

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/shares.ts
git commit -m "feat(server): shares routes support folder kind, expiresAt, getShareStatus"
```

---

### Task 5: `routes/sharepage.ts` — SSR folder browsing + expired page

**Files:**
- Modify: `server/src/routes/sharepage.ts`

**Interfaces:**
- Consumes: `getShareStatus` (Task 3); `isMd`, `isCanvas`, `isUnlocked`, `resolveInShareFolder` (Task 4, all exported from `./shares.js`); `vault.isDirectory`, `vault.listDir` (Task 2); `IMAGE_EXT_RE`, `VIDEO_EXT_RE`, `AUDIO_EXT_RE` (Task 2, `mime.js`).
- Produces: `GET /share/:id` (now branches file/folder/expired), new `GET /share/:id/f?path=`.

- [ ] **Step 1: Full replacement of `server/src/routes/sharepage.ts`**

```ts
// SSR page for public share links (FR-10): GET /share/:id returns a complete
// HTML document — note content, <title>, meta description, Open Graph + Twitter
// tags — so crawlers (Google, FB, Zalo…) index/preview it without running JS.
// Folder shares (kind: 'folder') are SSR too: GET /share/:id (root) and
// GET /share/:id/f?path=<subpath> render a read-only file browser, one page
// per level/file — no client-side JS is required to browse or read any of it.
import { Router } from 'express';
import type { Request } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asyncHandler } from '../middleware/error.js';
import * as vault from '../services/vault.js';
import type { TreeNode } from '../services/vault.js';
import { getShareStatus, type ShareRecord } from '../services/shares.js';
import { isUnlocked, isMd, isCanvas, resolveInShareFolder } from './shares.js';
import { renderNoteHtml, metaDescription, firstImage, escapeHtml } from '../services/renderhtml.js';
import { renderCanvasHtml, canvasDescription, canvasFirstImage, canvasViewerScript } from '../services/rendercanvas.js';
import { IMAGE_EXT_RE, VIDEO_EXT_RE, AUDIO_EXT_RE } from '../services/mime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Inline the built SPA stylesheet so the SSR page matches the Reading view. */
let cssCache: { file: string; css: string } | null = null;
async function appCss(): Promise<string> {
  const assets = path.join(__dirname, '..', '..', 'public', 'assets');
  try {
    const files = (await fs.readdir(assets)).filter((f) => /^index-.*\.css$/.test(f)).sort();
    const file = files.at(-1);
    if (!file) return '';
    if (cssCache?.file !== file) {
      cssCache = { file, css: await fs.readFile(path.join(assets, file), 'utf8') };
    }
    return cssCache.css;
  } catch {
    return '';
  }
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

function page(opts: {
  title: string;
  head?: string;
  body: string;
  css: string;
  noindex?: boolean;
  /** Skip the narrow markdown-preview column (used by the full-width canvas view). */
  bare?: boolean;
}): string {
  const inner = opts.bare
    ? opts.body
    : `<div class="markdown-preview">
<div class="preview-inner">
${opts.body}
</div>
</div>`;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${opts.noindex ? 'noindex, nofollow' : 'index, follow'}" />
<title>${escapeHtml(opts.title)}</title>
${opts.head ?? ''}<style>${opts.css}</style>
</head>
<body>
<div class="theme-light public-page${opts.bare ? ' public-canvas' : ''}">
${inner}
</div>
</body>
</html>`;
}

const notFoundPage = (css: string) =>
  page({
    title: 'Note not found',
    noindex: true,
    css,
    body: '<div class="public-error">This note is not available.</div>',
  });

const expiredPage = (css: string) =>
  page({
    title: 'Link expired',
    noindex: true,
    css,
    body: '<div class="public-error">This share link has expired.</div>',
  });

function unlockPage(share: ShareRecord, css: string, nonce: string): string {
  return page({
    title: 'Protected note',
    noindex: true,
    css,
    body: `
<form class="public-unlock" id="unlock-form">
  <div class="public-unlock-title">This note is password-protected</div>
  <input class="text-input" type="password" id="unlock-pw" placeholder="Password" autofocus />
  <button class="btn" type="submit">Open note</button>
  <div class="public-unlock-error" id="unlock-err"></div>
</form>
<script nonce="${nonce}">
document.getElementById('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/public/shares/${share.id}/unlock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('unlock-pw').value }),
  }).catch(() => null);
  if (r && r.ok) location.reload();
  else document.getElementById('unlock-err').textContent = 'Wrong password — try again.';
});
</script>`,
  });
}

/** Breadcrumb for a path inside a folder share: root name, then each segment. */
function breadcrumb(share: ShareRecord, rel: string): string {
  const rootName = share.path.split('/').pop() ?? share.path;
  const relToRoot = rel === share.path ? '' : rel.slice(share.path.length + 1);
  const segs = relToRoot ? relToRoot.split('/') : [];
  const rootPart = segs.length === 0
    ? `<span>${escapeHtml(rootName)}</span>`
    : `<a href="/share/${share.id}">${escapeHtml(rootName)}</a>`;
  const parts = [rootPart];
  let acc = '';
  segs.forEach((seg, i) => {
    acc = acc ? `${acc}/${seg}` : seg;
    const isLast = i === segs.length - 1;
    parts.push(
      isLast
        ? `<span>${escapeHtml(seg)}</span>`
        : `<a href="/share/${share.id}/f?path=${encodeURIComponent(acc)}">${escapeHtml(seg)}</a>`,
    );
  });
  return `<div class="public-breadcrumb">${parts.join(' <span class="public-breadcrumb-sep">/</span> ')}</div>`;
}

/** Read-only listing of a folder-share directory (reuses the in-app FolderView look). */
async function folderListingBody(share: ShareRecord, rel: string): Promise<string> {
  const entries: TreeNode[] = await vault.listDir(rel);
  const crumb = breadcrumb(share, rel);
  if (entries.length === 0) return `${crumb}<p class="folder-empty">This folder is empty.</p>`;
  const rows = entries
    .map((e) => {
      const childSub = e.path.slice(share.path.length + 1);
      const href = `/share/${share.id}/f?path=${encodeURIComponent(childSub)}`;
      const label = e.type === 'file' ? e.name.replace(/\.(md|markdown)$/i, '') : `${e.name}/`;
      const thumb = e.type === 'file' && IMAGE_EXT_RE.test(e.name)
        ? `<img class="folder-thumb" src="/public/shares/${share.id}/file?path=${encodeURIComponent(e.path)}" alt="" loading="lazy" />`
        : '';
      return `<a class="folder-entry" href="${href}">${thumb}<span class="folder-entry-name">${escapeHtml(label)}</span></a>`;
    })
    .join('');
  return `${crumb}<div class="folder-list">${rows}</div>`;
}

function mediaViewerBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(rel)}`;
  const tag = IMAGE_EXT_RE.test(name)
    ? `<img class="public-file-media" src="${url}" alt="${escapeHtml(name)}" />`
    : VIDEO_EXT_RE.test(name)
      ? `<video class="public-file-media" src="${url}" controls preload="metadata"></video>`
      : `<audio src="${url}" controls preload="metadata"></audio>`;
  return `${breadcrumb(share, rel)}<div class="public-file-view">${tag}</div>`;
}

function downloadBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(rel)}`;
  return `${breadcrumb(share, rel)}<div class="public-file-download"><p>${escapeHtml(name)}</p><a class="btn" href="${url}" download>Download</a></div>`;
}

export const sharePageRouter = Router();

sharePageRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    const css = await appCss();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (status.status === 'not_found') {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (status.status === 'expired') {
      res.status(404).send(expiredPage(css));
      return;
    }
    const share = status.record;
    if (!(await vault.exists(share.path))) {
      res.status(404).send(notFoundPage(css));
      return;
    }

    // Password-protected & not unlocked: render the unlock form only — never
    // leak content or descriptive metadata to crawlers.
    if (!(await isUnlocked(req, share))) {
      res.send(unlockPage(share, css, res.locals.cspNonce));
      return;
    }

    if (share.kind === 'folder') {
      const title = share.path.split('/').pop() ?? share.path;
      const body = await folderListingBody(share, share.path);
      res.send(
        page({
          title,
          noindex: true,
          css,
          body: `<div class="inline-title">${escapeHtml(title)}</div>\n${body}`,
        }),
      );
      return;
    }

    const pageUrl = `${baseUrl(req)}/share/${share.id}`;
    const content = await vault.readFileText(share.path);
    const isCv = isCanvas(share.path);
    const title = (share.path.split('/').pop() ?? share.path).replace(/\.(md|markdown|canvas)$/i, '');
    const fileUrl = (p: string) => `/public/shares/${share.id}/file?path=${encodeURIComponent(p)}`;
    const desc = isCv ? canvasDescription(content) : metaDescription(content);
    const imgVault = isCv ? canvasFirstImage(content) : null;
    const img = isCv ? null : firstImage(content);
    const ogImage = img?.url ?? (img?.vault ?? imgVault
      ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent((img?.vault ?? imgVault) as string)}`
      : null);

    const html = isCv
      ? await renderCanvasHtml(content, fileUrl)
      : await renderNoteHtml(content, fileUrl);

    const head = [
      `<meta name="description" content="${escapeHtml(desc)}" />`,
      `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
      `<meta property="og:type" content="article" />`,
      `<meta property="og:site_name" content="WebObsidian" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(desc)}" />`,
      `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
      ...(ogImage ? [
        `<meta property="og:image" content="${escapeHtml(ogImage)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`,
      ] : [
        `<meta name="twitter:card" content="summary" />`,
      ]),
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
    ].join('\n') + '\n';

    res.send(
      page({
        title,
        head,
        css,
        bare: isCv,
        body: isCv
          ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
          : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}`,
      }),
    );
  }),
);

sharePageRouter.get(
  '/:id/f',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    const css = await appCss();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (status.status === 'not_found') {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (status.status === 'expired') {
      res.status(404).send(expiredPage(css));
      return;
    }
    const share = status.record;
    if (share.kind !== 'folder' || !(await vault.exists(share.path))) {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (!(await isUnlocked(req, share))) {
      res.send(unlockPage(share, css, res.locals.cspNonce));
      return;
    }

    const rel = await resolveInShareFolder(share, String(req.query.path ?? ''));
    if (!rel) {
      res.status(404).send(notFoundPage(css));
      return;
    }

    if (await vault.isDirectory(rel)) {
      const title = rel.split('/').pop() ?? rel;
      const body = await folderListingBody(share, rel);
      res.send(
        page({ title, noindex: true, css, body: `<div class="inline-title">${escapeHtml(title)}</div>\n${body}` }),
      );
      return;
    }

    const name = rel.split('/').pop() ?? rel;

    if (isMd(rel) || isCanvas(rel)) {
      const content = await vault.readFileText(rel);
      const isCv = isCanvas(rel);
      const fileUrl = (p: string) => `/public/shares/${share.id}/file?path=${encodeURIComponent(p)}`;
      const html = isCv ? await renderCanvasHtml(content, fileUrl) : await renderNoteHtml(content, fileUrl);
      const title = name.replace(/\.(md|markdown|canvas)$/i, '');
      res.send(
        page({
          title,
          noindex: true,
          css,
          bare: isCv,
          body: `${breadcrumb(share, rel)}\n${
            isCv
              ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
              : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}`
          }`,
        }),
      );
      return;
    }

    if (IMAGE_EXT_RE.test(name) || VIDEO_EXT_RE.test(name) || AUDIO_EXT_RE.test(name)) {
      res.send(page({ title: name, noindex: true, css, body: mediaViewerBody(share, rel, name) }));
      return;
    }

    res.send(page({ title: name, noindex: true, css, body: downloadBody(share, rel, name) }));
  }),
);
```

- [ ] **Step 2: Typecheck**

Run: `npm --workspace server run typecheck`
Expected: exits 0, no errors.

- [ ] **Step 3: Run the full test suite once more**

Run: `npm --workspace server run test`
Expected: PASS, same 11 tests as Task 3 (this task added no new pure logic to unit-test — folder SSR rendering is verified in Task 11).

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/sharepage.ts
git commit -m "feat(server): SSR folder-share browsing (GET /share/:id/f) + expired-link page"
```

---

### Task 6: Web CSS — breadcrumb, file-view, download, folder-entry link fix

**Files:**
- Modify: `web/src/styles/obsidian.css`

**Interfaces:**
- Produces: `.public-breadcrumb`, `.public-breadcrumb-sep`, `.public-file-view`, `.public-file-media`, `.public-file-download` classes; `text-decoration: none` added to the existing `.folder-entry` rule so it works as an `<a>` on the SSR pages (Task 5) as well as the existing in-app `<div onClick>` usage (`FolderView.tsx`).

This CSS is bundled by `vite build` into `web/dist/assets/index-*.css`, which the server's `appCss()` (Task 5) reads from `server/public/assets/` and inlines into every SSR share page — so these classes must exist here, not in a server-side stylesheet.

- [ ] **Step 1: Add `text-decoration: none` to the existing `.folder-entry` rule**

Find (around line 888):

```css
.folder-entry { display: flex; align-items: center; gap: 10px; padding: 7px 10px; cursor: pointer;
  border-radius: var(--radius-s); color: var(--text-normal); }
```

Replace with:

```css
.folder-entry { display: flex; align-items: center; gap: 10px; padding: 7px 10px; cursor: pointer;
  border-radius: var(--radius-s); color: var(--text-normal); text-decoration: none; }
```

- [ ] **Step 2: Add the new public-share classes**

Insert after the existing `.public-unlock-error` rule (around line 1061):

```css
.public-breadcrumb { display: flex; flex-wrap: wrap; gap: 4px; color: var(--text-muted); font-size: 13px; margin-bottom: 14px; }
.public-breadcrumb a { color: var(--text-muted); text-decoration: none; }
.public-breadcrumb a:hover { color: var(--text-normal); text-decoration: underline; }
.public-breadcrumb span { color: var(--text-normal); }
.public-breadcrumb-sep { color: var(--text-faint); }

.public-file-view { display: flex; justify-content: center; padding: 20px 0; }
.public-file-media { max-width: 100%; border-radius: var(--radius-s); }
.public-file-download { text-align: center; padding: 40px 0; color: var(--text-normal); }
.public-file-download p { margin-bottom: 12px; word-break: break-all; }
```

- [ ] **Step 3: Build the web bundle so the server can inline the new CSS**

Run: `npm run build`
Expected: exits 0. `web/dist` and `server/public` (copied by the build) contain the new `index-*.css` with the classes above.

- [ ] **Step 4: Commit**

```bash
git add web/src/styles/obsidian.css
git commit -m "style(web): CSS for public folder-share breadcrumb/file-view/download pages"
```

---

### Task 7: `web/src/lib/api.ts` — `kind`/`expiresAt` on `ShareRecord`, `setShareExpiry`

**Files:**
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Produces: `ShareRecord.kind: 'file' | 'folder'`, `ShareRecord.expiresAt?: string | null`, `api.createShare(path, kind?)`, `api.setShareExpiry(id, expiresAt)` — consumed by Task 8/9.

- [ ] **Step 1: Update the `ShareRecord` interface**

Find (around line 23):

```ts
export interface ShareRecord {
  id: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  hasPassword?: boolean;
}
```

Replace with:

```ts
export interface ShareRecord {
  id: string;
  path: string;
  kind: 'file' | 'folder';
  enabled: boolean;
  createdAt: string;
  expiresAt?: string | null;
  hasPassword?: boolean;
}
```

- [ ] **Step 2: Update `createShare` and add `setShareExpiry`**

Find (around line 238-246):

```ts
  listShares: () => req<{ shares: ShareRecord[] }>('/api/shares/'),
  createShare: (path: string) =>
    req<{ share: ShareRecord }>('/api/shares/', { method: 'POST', body: JSON.stringify({ path }) }),
  setShareEnabled: (id: string, enabled: boolean) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteShare: (id: string) => req<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // password = null clears the share's password
  setSharePassword: (id: string, password: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) }),
```

Replace with:

```ts
  listShares: () => req<{ shares: ShareRecord[] }>('/api/shares/'),
  createShare: (path: string, kind: 'file' | 'folder' = 'file') =>
    req<{ share: ShareRecord }>('/api/shares/', { method: 'POST', body: JSON.stringify({ path, kind }) }),
  setShareEnabled: (id: string, enabled: boolean) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteShare: (id: string) => req<{ ok: true }>(`/api/shares/${id}`, { method: 'DELETE' }),
  // password = null clears the share's password
  setSharePassword: (id: string, password: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ password }) }),
  // expiresAt = null clears the share's expiry (never expires)
  setShareExpiry: (id: string, expiresAt: string | null) =>
    req<{ share: ShareRecord }>(`/api/shares/${id}`, { method: 'PATCH', body: JSON.stringify({ expiresAt }) }),
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace web run typecheck`
Expected: exits 0 (nothing consumes the new fields yet, so no errors — Task 8 wires the UI).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(web): api client for share kind + expiresAt"
```

---

### Task 8: `ShareDialog.tsx` — folder kind + expiry presets

**Files:**
- Modify: `web/src/components/ShareDialog.tsx`

**Interfaces:**
- Consumes: `api.createShare(path, kind)`, `api.setShareExpiry(id, expiresAt)` (Task 7).

- [ ] **Step 1: Derive `kind` from the path and use it when creating**

Find:

```tsx
  if (!path) return null;
  const close = () => setShareDialog(null);
  const share = shares.find((s) => s.path === path) ?? null;
  const url = share ? `${location.origin}/share/${share.id}` : '';

  const create = async () => {
    await api.createShare(path);
    await loadShares();
    notify('Public link created');
  };
```

Replace with:

```tsx
  if (!path) return null;
  const kind: 'file' | 'folder' = /\.(md|markdown|canvas)$/i.test(path) ? 'file' : 'folder';
  const close = () => setShareDialog(null);
  const share = shares.find((s) => s.path === path) ?? null;
  const url = share ? `${location.origin}/share/${share.id}` : '';

  const create = async () => {
    await api.createShare(path, kind);
    await loadShares();
    notify('Public link created');
  };
```

- [ ] **Step 2: Update the dialog title for folders**

Find:

```tsx
            <div className="share-dialog-title">{/\.canvas$/i.test(path) ? 'Share canvas' : 'Share note'}</div>
```

Replace with:

```tsx
            <div className="share-dialog-title">
              {kind === 'folder' ? 'Share folder' : /\.canvas$/i.test(path) ? 'Share canvas' : 'Share note'}
            </div>
```

- [ ] **Step 3: Add the expiry preset row**

Find:

```tsx
            <div className="setting-row">
              <div className="info">
                <div className="name">Password protection</div>
```

Insert directly above it (so expiry sits between the URL/toggle block and password):

```tsx
            {share.enabled && (
              <div className="setting-row">
                <div className="info">
                  <div className="name">Expiry</div>
                  <div className="desc">
                    {share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}` : 'Never expires'}
                  </div>
                </div>
              </div>
            )}
            {share.enabled && (
              <div className="recent-filter-row">
                {EXPIRY_PRESETS.map((p) => (
                  <button key={p.label} className="recent-filter-btn" onClick={() => setExpiry(p.days)}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="setting-row">
              <div className="info">
                <div className="name">Password protection</div>
```

- [ ] **Step 4: Add the `EXPIRY_PRESETS` constant and `setExpiry` handler**

Find:

```tsx
  const password = async () => {
```

Insert directly above it:

```tsx
  const EXPIRY_PRESETS: { label: string; days: number | null }[] = [
    { label: '1 day', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: 'No limit', days: null },
  ];
  const setExpiry = async (days: number | null) => {
    if (!share) return;
    const iso = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    await api.setShareExpiry(share.id, iso);
    await loadShares();
    notify(days === null ? 'Link no longer expires' : `Link now expires in ${days} day${days === 1 ? '' : 's'}`);
  };
  const password = async () => {
```

- [ ] **Step 5: Typecheck**

Run: `npm --workspace web run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ShareDialog.tsx
git commit -m "feat(web): ShareDialog supports folders + expiry presets"
```

---

### Task 9: `FileTree.tsx` — folder "Share…" menu item + badge

**Files:**
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes: `setShareDialog` (already destructured in this component), `shares` (already destructured in this component).

- [ ] **Step 1: Add "Share…" to the folder context menu**

Find (in the `isFolder` branch of the context-menu `items` array):

```tsx
          { label: 'Rename…', onClick: doRename },
          { label: 'Move folder to…', onClick: doMove },
          { label: 'Copy path', onClick: copyPath },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ]
      : [
```

Replace with:

```tsx
          { label: 'Rename…', onClick: doRename },
          { label: 'Move folder to…', onClick: doMove },
          { label: 'Copy path', onClick: copyPath },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: 'Share…', icon: 'globe', onClick: () => setShareDialog(node.path) },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ]
      : [
```

- [ ] **Step 2: Add the globe badge to the folder row**

Find (in the `isFolder` render branch):

```tsx
          {editing ? (
            <RenameInput node={node} onDone={() => setRenamingPath(null)} />
          ) : (
            <span className="name">{node.name}</span>
          )}
        </div>
        {open && (
```

Replace with:

```tsx
          {editing ? (
            <RenameInput node={node} onDone={() => setRenamingPath(null)} />
          ) : (
            <span className="name">{node.name}</span>
          )}
          {shares.some((s) => s.path === node.path && s.enabled) && (
            <Icon name="globe" size={12} className="share-globe" />
          )}
        </div>
        {open && (
```

- [ ] **Step 3: Typecheck**

Run: `npm --workspace web run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/FileTree.tsx
git commit -m "feat(web): folder Share… context menu + share badge on folders"
```

---

### Task 10: Full build + server test suite + typecheck (final gate before manual E2E)

**Files:** none (verification only).

- [ ] **Step 1: Run the full server test suite**

Run: `npm --workspace server run test`
Expected: PASS, 11/11.

- [ ] **Step 2: Full typecheck (both workspaces)**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Full production build**

Run: `npm run build`
Expected: exits 0 — `web` builds first (emits the CSS from Task 6 into `web/dist`), then `server` builds (`tsc`, `*.test.ts` excluded per Task 1 Step 3) and its `public/` gets the freshly built web assets (check `server/package.json`'s build wiring — this repo's existing `npm run build` already copies `web/dist` → `server/public`, no new step needed here).

- [ ] **Step 4: If any step fails, fix and re-run before proceeding — do not continue to Task 11 on a red build.**

---

### Task 11: Manual end-to-end verification (real vault, real server, no mocks)

Per this repo's CLAUDE.md ("chỉ output chạy được ngay, test thật trước khi trả lại người dùng") — run the actual dev server against a real vault folder and drive both the authenticated management flow and the anonymous public flow. The public folder-share pages are pure server-rendered HTML with no JS, so `curl` against a running server *is* a faithful "real user" test for them (no browser needed to prove they work); the two React pieces (ShareDialog buttons, FileTree context menu) are covered by the typecheck in Task 10 plus this manual click-through.

- [ ] **Step 1: Start the dev server**

Run: `npm run dev` (background — leave running for the rest of this task)
Expected: server on `:3000`ish + Vite dev server; confirm `curl -s http://localhost:<port>/healthz` returns `{"ok":true}`.

- [ ] **Step 2: Log in and create a real nested folder in the sample vault**

Use the running app (or `curl` against `/auth/login` + `/api/files/folder` + `/api/files/content` with the session cookie) to create, inside the existing `sample-vault`:
- `E2E-Share/note.md` (some text content)
- `E2E-Share/Sub/inner.md`
- `E2E-Share/Sub/photo.png` (any small real PNG)

- [ ] **Step 3: Create a folder share via the real API and verify JSON shape**

Run: `curl -s -b cookies.txt -X POST http://localhost:<port>/api/shares/ -H 'Content-Type: application/json' -d '{"path":"E2E-Share","kind":"folder"}'`
Expected: `{"share":{"id":"...","path":"E2E-Share","kind":"folder","enabled":true,"createdAt":"...","hasPassword":false}}`

- [ ] **Step 4: Anonymously browse the folder root — no cookies, simulating a real visitor**

Run: `curl -s http://localhost:<port>/share/<id> | grep -o 'folder-entry-name">[^<]*'`
Expected: shows `note`, `Sub/` (the two root entries, note title stripped of `.md`).

- [ ] **Step 5: Navigate into the subfolder**

Run: `curl -s "http://localhost:<port>/share/<id>/f?path=Sub" | grep -o 'folder-entry-name">[^<]*'`
Expected: shows `inner`, `photo.png`.

- [ ] **Step 6: Open the nested note and confirm its rendered content is present**

Run: `curl -s "http://localhost:<port>/share/<id>/f?path=Sub/inner.md" | grep -c "markdown-preview\|public-breadcrumb"`
Expected: non-zero — breadcrumb + rendered note body present.

- [ ] **Step 7: Fetch the nested image through the public file endpoint**

Run: `curl -s -o /dev/null -w '%{http_code} %{content_type}\n' "http://localhost:<port>/public/shares/<id>/file?path=E2E-Share/Sub/photo.png"`
Expected: `200 image/png`.

- [ ] **Step 8: Confirm traversal is refused**

Run: `curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:<port>/share/<id>/f?path=../../../etc/passwd"`
Expected: `404`.

- [ ] **Step 9: Set a 1-day expiry via PATCH, confirm it round-trips**

Run: `curl -s -b cookies.txt -X PATCH http://localhost:<port>/api/shares/<id> -H 'Content-Type: application/json' -d "{\"expiresAt\":\"$(date -u -v+1d +%Y-%m-%dT%H:%M:%S.000Z)\"}"`
(on Linux dev machines use `date -u -d '+1 day'` instead of `-v+1d`)
Expected: response JSON has the new `expiresAt`.

- [ ] **Step 10: Force-expire and confirm the dedicated expired page renders**

Run: `curl -s -b cookies.txt -X PATCH http://localhost:<port>/api/shares/<id> -H 'Content-Type: application/json' -d '{"expiresAt":"2020-01-01T00:00:00.000Z"}'`
Then: `curl -s http://localhost:<port>/share/<id> | grep -c "This share link has expired"`
Expected: `1`.

- [ ] **Step 11: Confirm the note-kind share flow still works unchanged (regression check)**

Run: `curl -s -b cookies.txt -X POST http://localhost:<port>/api/shares/ -H 'Content-Type: application/json' -d '{"path":"E2E-Share/note.md","kind":"file"}'`, then `curl -s http://localhost:<port>/share/<new-id> | grep -c "inline-title"`
Expected: `1` (unchanged single-note SSR behavior still works).

- [ ] **Step 12: In a real browser (or note the limitation), click through `ShareDialog`**

Open the app in a browser, right-click `E2E-Share` folder → "Share…" → confirm the dialog shows "Share folder", create the link, click each of the 4 expiry preset buttons and confirm the "Expires …" text updates, click the folder's globe badge appears in the tree after creating. If no interactive browser is available in this environment, state that explicitly instead of claiming it was clicked through.

- [ ] **Step 13: Clean up the E2E vault fixtures**

Delete `E2E-Share/` from the sample vault (via the app or `curl -X DELETE`) and delete the two test share records, so the dev vault used for this session doesn't ship stray data as part of the deploy in Task 12. Stop the dev server.

---

### Task 12: Merge to `main`, push to `fork`, deploy to prod

Per this repo's `CLAUDE.md` (`Remote git` section): work happens in this worktree, but must be merged into `main` at the root checkout and pushed to `fork` before the session ends — the worktree branch is deleted when the session closes. The user's explicit instruction for this task is full autonomy through deploy; still confirm the deploy step actually succeeded before declaring done.

- [ ] **Step 1: Flip every `[ ]` to `[x]` in IMPLEMENTATION_PLAN.md Phase 33**

Only after Task 11 has actually verified each milestone — mark M33.1–M33.6 `[x]`, add a dated entry to "Nhật ký tiến độ" summarizing what shipped (mirror the style of the existing Phase 30–32 entries), update the "Cập nhật lần cuối" line. Commit this alongside M33.7 once deploy is confirmed (Step 6 below) — or as two commits if deploy needs its own follow-up entry.

- [ ] **Step 2: In the worktree, confirm a clean state**

Run: `git status --short`
Expected: clean (everything from Tasks 1–11 already committed).

- [ ] **Step 3: Switch to the root checkout and merge this worktree branch into `main`**

```bash
cd /Users/henry/Documents/Projects/webobsidian
git fetch fork main
git merge fork/main --no-edit   # pick up anything landed on fork/main since this worktree branched
git merge worktree-bridge-cse_01KG4nDeYsQcygxPJ5FzFyUy --no-edit
```

If this conflicts, it will most likely be in `PRD.md`'s changelog header (`> Phiên bản: X.Y`) and/or `IMPLEMENTATION_PLAN.md`'s `Cập nhật lần cuối` line / a colliding `## Phase N` heading, if someone else landed work on `fork/main` in the meantime. Resolve by keeping **both** sides' changelog entries (don't drop either), bumping this branch's PRD version number to be one above whatever `fork/main` now has, and renumbering this branch's `## Phase 33` heading (and its `M33.x` milestone IDs, and the `PRD 1.10` cross-reference in its title) to the next free phase number if `fork/main` already used 33 for something else — mirror exactly how the PRD.md/IMPLEMENTATION_PLAN.md conflicts were resolved earlier in this same session (commit `b82597e`, message "Merge remote-tracking branch 'fork/main'…") as a worked example of the pattern.

- [ ] **Step 4: Push to `fork`**

Run: `git push fork main`
Expected: exits 0.

- [ ] **Step 5: Deploy to the production droplet**

Read `../_deployments/webobsidian-web.md` first (per `CLAUDE.md`) for the current exact command and any since-updated caveats, then run (expect a multi-minute build on the 2GB droplet — run with a long timeout or in the background, per that doc's existing warning about SSH sessions getting cut mid-build):

```bash
ssh root@159.65.128.188 'cd /opt/webobsidian && git pull && docker compose up -d --build'
```

- [ ] **Step 6: Verify the deploy**

```bash
curl -s https://obsidian.henry-group.uk/healthz
ssh root@159.65.128.188 'cd /opt/webobsidian && git log -1 --oneline'
```

Expected: `{"ok":true}` and the commit hash matches what was just pushed. Then do a light real-world smoke check against prod itself: log in, create one small real folder share on the live vault, open its public URL from a fresh (unauthenticated) request, confirm it renders, then delete that test share.

- [ ] **Step 7: Commit the final IMPLEMENTATION_PLAN.md deploy note (M33.7) and push**

```bash
cd /Users/henry/Documents/Projects/webobsidian
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: mark Phase 33 (share thư mục + share có thời hạn) done, deployed to prod"
git push fork main
```
