/**
 * Ticket cho luồng truyền file qua HTTP, NGOÀI luồng MCP (FR-16).
 *
 * Ticket sống trong RAM chứ không ghi `settings.json`: chúng ephemeral (TTL 30
 * phút), mất khi restart là chấp nhận được, và giữ `settings.json` sạch.
 */
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import type { OnConflict, ExtractResult } from './archive.js';

export const TTL_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

export interface DownloadTicket {
  kind: 'download';
  id: string;
  zipPath: string;
  filename: string;
  fileCount: number;
  bytes: number;
  expiresAt: number;
}

export interface UploadTicket {
  kind: 'upload';
  id: string;
  destFolder: string;
  onConflict: OnConflict;
  status: 'pending' | 'done' | 'error';
  result?: ExtractResult;
  error?: string;
  claimed: boolean;
  expiresAt: number;
}

export type Ticket = DownloadTicket | UploadTicket;

const tickets = new Map<string, Ticket>();

/** Token 256-bit: entropy đủ lớn nên tra Map trực tiếp là an toàn (không cần so
 *  sánh timing-safe). KHÔNG BAO GIỜ ghi token ra log. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createDownloadTicket(o: {
  zipPath: string;
  filename: string;
  fileCount: number;
  bytes: number;
}): DownloadTicket {
  const t: DownloadTicket = { kind: 'download', id: newToken(), ...o, expiresAt: Date.now() + TTL_MS };
  tickets.set(t.id, t);
  return t;
}

export function createUploadTicket(o: { destFolder: string; onConflict: OnConflict }): UploadTicket {
  const t: UploadTicket = {
    kind: 'upload',
    id: newToken(),
    ...o,
    status: 'pending',
    claimed: false,
    expiresAt: Date.now() + TTL_MS,
  };
  tickets.set(t.id, t);
  return t;
}

export function getTicket(id: string, now: number = Date.now()): Ticket | null {
  const t = tickets.get(id);
  if (!t) return null;
  if (now > t.expiresAt) return null;
  return t;
}

/** Ticket đẩy dùng ĐÚNG MỘT LẦN: lần claim thứ hai trả null. */
export function claimUploadTicket(id: string, now: number = Date.now()): UploadTicket | null {
  const t = getTicket(id, now);
  if (!t || t.kind !== 'upload' || t.claimed) return null;
  t.claimed = true;
  return t;
}

export function finishUploadTicket(id: string, result: ExtractResult): void {
  const t = tickets.get(id);
  if (t?.kind === 'upload') {
    t.status = 'done';
    t.result = result;
  }
}

/** Thất bại thì mở lại ticket để người dùng thử lại — chưa có gì được ghi. */
export function failUploadTicket(id: string, error: string): void {
  const t = tickets.get(id);
  if (t?.kind === 'upload') {
    t.status = 'error';
    t.error = error;
    t.claimed = false;
  }
}

/** Xoá ticket hết hạn kèm file zip của nó. */
export function sweep(now: number = Date.now()): void {
  for (const [id, t] of tickets) {
    if (now <= t.expiresAt) continue;
    tickets.delete(id);
    if (t.kind === 'download') void fs.rm(t.zipPath, { force: true }).catch(() => {});
  }
}

let sweeper: NodeJS.Timeout | null = null;
export function startSweeper(): void {
  if (sweeper) return;
  sweeper = setInterval(() => sweep(), SWEEP_INTERVAL_MS);
  sweeper.unref(); // đừng giữ process sống chỉ vì cái timer này
}

function dirPath(): string {
  return path.join(config.dataDir, 'transfer');
}

export async function transferDir(): Promise<string> {
  const dir = dirPath();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Dọn sạch lúc boot: ticket sống trong RAM nên mọi zip còn sót đều mồ côi. */
export async function cleanTransferDir(): Promise<void> {
  const dir = dirPath();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
}

/** Chỉ dùng trong test. */
export function __resetForTests(): void {
  tickets.clear();
}
