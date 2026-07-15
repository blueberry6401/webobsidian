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
