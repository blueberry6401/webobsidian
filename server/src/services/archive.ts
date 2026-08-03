/**
 * Nén / giải nén ZIP cho tính năng truyền file hàng loạt (FR-16).
 *
 * Cả hai chiều đều chạy theo STREAM (`archiver` / `yauzl`) nên bộ nhớ phẳng bất
 * kể vault to — quan trọng với container Docker giới hạn RAM.
 */
import path from 'node:path';
import { createWriteStream, promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import yauzl from 'yauzl';
import * as vault from './vault.js';

export type OnConflict = 'rename' | 'overwrite' | 'skip';

/** Chặn zip bomb: dừng khi vượt một trong hai ngưỡng. */
export const MAX_ENTRIES = 10_000;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Segment không bao giờ được ghi từ một archive. */
const FORBIDDEN_SEGMENTS = new Set(['.trash', '.git', '.gitmodules', '.gitattributes']);

/**
 * Chuẩn hoá + kiểm tra một đường dẫn entry trong ZIP. Trả về đường dẫn
 * vault-relative dùng dấu `/`, hoặc `null` nếu entry phải bị từ chối.
 *
 * Đây là chốt chặn zip-slip. `vault.resolveInVault()` là lớp phòng thủ thứ hai,
 * nhưng ta chặn ngay ở đây để không bao giờ tạo thư mục trung gian cho một
 * entry độc hại.
 */
export function safeEntryPath(raw: string): string | null {
  if (!raw || raw.includes('\0')) return null;
  const norm = raw.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm || norm === '.') return null;
  if (norm.startsWith('/')) return null;
  if (/^[a-zA-Z]:/.test(norm)) return null; // "C:/..." của Windows
  const segs = norm.split('/').filter((s) => s.length > 0);
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
    if (FORBIDDEN_SEGMENTS.has(s.toLowerCase())) return null;
  }
  return segs.join('/');
}

/**
 * Chọn đường dẫn đích cho một entry, theo chính sách xung đột.
 * `rename` → `note.md` thành `note (1).md`, tăng dần.
 */
export async function pickTarget(
  rel: string,
  onConflict: OnConflict,
  exists: (p: string) => Promise<boolean>,
): Promise<{ target: string } | { skip: true }> {
  if (!(await exists(rel))) return { target: rel };
  if (onConflict === 'overwrite') return { target: rel };
  if (onConflict === 'skip') return { skip: true };
  const dir = path.posix.dirname(rel);
  const base = path.posix.basename(rel);
  const dot = base.lastIndexOf('.');
  // `dot > 0` chứ không `>= 0`: dotfile như `.env` không có phần đuôi mở rộng.
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = (dir === '.' ? '' : dir + '/') + `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return { target: candidate };
  }
  throw new Error(`Không tìm được tên trống cho ${rel}`);
}

/** Nén danh sách file thành ZIP tại `zipPath`. */
export async function createZip(
  files: { abs: string; rel: string }[],
  zipPath: string,
): Promise<{ fileCount: number; bytes: number }> {
  const out = createWriteStream(zipPath);
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve());
    out.on('error', reject);
    zip.on('error', reject);
  });
  zip.pipe(out);
  for (const f of files) zip.file(f.abs, { name: f.rel });
  await zip.finalize();
  await done;
  const st = await fs.stat(zipPath);
  return { fileCount: files.length, bytes: st.size };
}

export interface ExtractResult {
  written: string[];
  skipped: string[];
  errors: { path: string; error: string }[];
}

/** Bit S_IFLNK trong 16 bit cao của externalFileAttributes (ZIP tạo trên Unix). */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

/**
 * Giải nén `zipPath` vào `destFolder` (vault-relative, '' = gốc vault).
 *
 * Entry symlink bị BỎ QUA hoàn toàn: ZIP lưu được symlink, và một symlink trỏ ra
 * `/etc` sẽ biến lần ghi kế tiếp thành ghi đè file hệ thống.
 */
export async function extractZip(
  zipPath: string,
  destFolder: string,
  onConflict: OnConflict,
): Promise<ExtractResult> {
  const result: ExtractResult = { written: [], skipped: [], errors: [] };
  const dest = destFolder.replace(/^[/\\]+|[/\\]+$/g, '');
  let entryCount = 0;
  let totalBytes = 0;

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) reject(err ?? new Error('Không mở được file zip'));
      else resolve(zf);
    });
  });

  await new Promise<void>((resolve, reject) => {
    zipfile.on('error', reject);
    zipfile.on('end', () => resolve());
    zipfile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        let fatal: Error | null = null;
        try {
          if (entry.fileName.endsWith('/')) return; // entry thư mục
          if (isSymlinkEntry(entry)) {
            result.skipped.push(`${entry.fileName} (symlink)`);
            return;
          }
          if (++entryCount > MAX_ENTRIES) {
            fatal = new Error(`Zip vượt giới hạn ${MAX_ENTRIES} entry`);
            return;
          }
          totalBytes += entry.uncompressedSize;
          if (totalBytes > MAX_TOTAL_BYTES) {
            fatal = new Error('Zip vượt giới hạn 2 GB sau khi giải nén');
            return;
          }

          const safe = safeEntryPath(entry.fileName);
          if (!safe) {
            result.errors.push({ path: entry.fileName, error: 'đường dẫn không hợp lệ' });
            return;
          }
          const rel = dest ? `${dest}/${safe}` : safe;
          const picked = await pickTarget(rel, onConflict, vault.exists);
          if ('skip' in picked) {
            result.skipped.push(rel);
            return;
          }
          // Lớp phòng thủ thứ hai: resolveInVault chặn traversal + symlink + .git.
          const abs = await vault.resolveInVault(picked.target);
          await fs.mkdir(path.dirname(abs), { recursive: true });
          const rs = await new Promise<NodeJS.ReadableStream>((res, rej) => {
            zipfile.openReadStream(entry, (err, s) =>
              err || !s ? rej(err ?? new Error('Không mở được stream entry')) : res(s),
            );
          });
          await pipeline(rs, createWriteStream(abs));
          vault.invalidateStat(picked.target);
          result.written.push(picked.target);
        } catch (e) {
          result.errors.push({ path: entry.fileName, error: (e as Error).message });
        } finally {
          if (fatal) {
            zipfile.close();
            reject(fatal);
          } else {
            zipfile.readEntry();
          }
        }
      })();
    });
    zipfile.readEntry();
  });

  return result;
}
