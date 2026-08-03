# MCP vault transfer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Thêm 4 tool MCP cho phép nén/giải nén file hàng loạt giữa máy người dùng và vault, và giữa hai vault, mà bytes không đi qua context của model.

**Architecture:** Tool chỉ cấp *link tạm thời*, dữ liệu đi bằng HTTP ngoài luồng MCP. Ticket sống trong RAM với TTL 30 phút; zip nằm ở `<dataDir>/transfer/`. Luồng vault A → B tự động hoàn toàn nhờ `upload_from_url` (server B tự fetch link của A).

**Tech Stack:** TypeScript, Express, `archiver` (nén stream), `yauzl` (giải nén stream), `multer` (đã có), vitest.

**Spec:** `docs/superpowers/specs/2026-08-03-mcp-vault-transfer-design.md`

## Global Constraints

- TypeScript cho server; tránh `any`.
- Cấu hình runtime chỉ dùng file JSON — ticket sống trong RAM, **không** ghi `settings.json`.
- Không log token/secret.
- TTL ticket: **30 phút**. Token: `randomBytes(32).toString('base64url')`.
- Giới hạn: download ≤ 5 000 file và ≤ 500 MB; giải nén ≤ 10 000 entry và ≤ 2 GB; fetch ≤ 500 MB, timeout kết nối 15 s, ≤ 3 redirect.
- `on_conflict` mặc định `rename`.
- Mọi đường ghi vào vault phải đi qua `vault.resolveInVault()` (đã guard traversal, symlink, `.git`).
- Cập nhật `PRD.md` **trước** khi code (quy tắc CLAUDE.md), `IMPLEMENTATION_PLAN.md` trong cùng lần thay đổi.

## File Structure

| File | Trách nhiệm |
|---|---|
| `server/src/services/archive.ts` | Nén/giải zip theo stream; guard zip-slip; xử lý `on_conflict` |
| `server/src/services/archive.test.ts` | Test cho hàm thuần của `archive.ts` |
| `server/src/services/transfer.ts` | Kho ticket trong RAM; TTL; sweeper; thư mục `<dataDir>/transfer` |
| `server/src/services/transfer.test.ts` | Test TTL, ticket dùng một lần, sweeper |
| `server/src/services/fetchzip.ts` | Guard SSRF + tải zip về đĩa |
| `server/src/services/fetchzip.test.ts` | Test guard IP bị chặn |
| `server/src/routes/transfer.ts` | `/transfer/d/:token`, `/transfer/u/:token` (GET trang + POST file) — **không auth** |
| `server/src/services/mcptools.ts` | + 4 tool; nhận `baseUrl` |
| `server/src/routes/mcp.ts` | Truyền `baseUrl` từ request vào `createMcpServer` |
| `server/src/index.ts` | Mount `/transfer`; **loại `/transfer` khỏi SPA catch-all**; dọn thư mục transfer lúc boot; khởi động sweeper |
| `server/scripts/verify-mcp.ts` | E2E round-trip 2 vault |

---

### Task 1: Cập nhật tài liệu thiết kế trước khi code

**Files:**
- Modify: `PRD.md`
- Modify: `IMPLEMENTATION_PLAN.md`

- [ ] **Step 1: Thêm FR mới vào PRD.md**

Thêm mục FR mô tả 4 tool MCP (`download_files`, `upload_from_url`, `upload_files`, `transfer_status`), endpoint `/transfer/*` không auth, giới hạn dung lượng, và các guard bảo mật (zip-slip, zip bomb, SSRF). Tăng version + thêm dòng changelog nêu lý do: MCP hiện chỉ thao tác một note text mỗi lần.

- [ ] **Step 2: Thêm mục vào IMPLEMENTATION_PLAN.md**

Thêm mục "MCP vault transfer" với các checkbox con khớp Task 2–8 của kế hoạch này, đánh `[~]`. Cập nhật dòng "Cập nhật lần cuối" và thêm dòng vào "Nhật ký tiến độ".

- [ ] **Step 3: Commit**

```bash
git add PRD.md IMPLEMENTATION_PLAN.md
git commit -m "docs: PRD + plan cho MCP vault transfer"
```

---

### Task 2: Dependency + guard zip-slip (hàm thuần)

**Files:**
- Modify: `server/package.json`
- Create: `server/src/services/archive.ts`
- Test: `server/src/services/archive.test.ts`

**Interfaces:**
- Produces: `type OnConflict = 'rename' | 'overwrite' | 'skip'`; `safeEntryPath(raw: string): string | null`; `MAX_ENTRIES`, `MAX_TOTAL_BYTES`.

- [ ] **Step 1: Cài dependency**

```bash
npm install --workspace server archiver yauzl
npm install --workspace server -D @types/archiver @types/yauzl
```

- [ ] **Step 2: Viết test thất bại**

```ts
// server/src/services/archive.test.ts
import { describe, it, expect } from 'vitest';
import { safeEntryPath } from './archive.js';

describe('safeEntryPath', () => {
  it('giữ nguyên đường dẫn hợp lệ', () => {
    expect(safeEntryPath('Notes/Ideas.md')).toBe('Notes/Ideas.md');
  });

  it('chuẩn hoá dấu gạch ngược của zip tạo trên Windows', () => {
    expect(safeEntryPath('Notes\\Sub\\a.md')).toBe('Notes/Sub/a.md');
  });

  it('từ chối đường dẫn leo ra ngoài', () => {
    expect(safeEntryPath('../../etc/passwd')).toBeNull();
    expect(safeEntryPath('Notes/../../etc/passwd')).toBeNull();
    expect(safeEntryPath('Notes\\..\\..\\etc\\passwd')).toBeNull();
  });

  it('từ chối đường dẫn tuyệt đối (POSIX và Windows)', () => {
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:/Windows/system32')).toBeNull();
    expect(safeEntryPath('\\\\server\\share\\a.md')).toBeNull();
  });

  it('từ chối byte NUL', () => {
    expect(safeEntryPath('a\0b.md')).toBeNull();
  });

  it('từ chối ghi vào .trash và .git', () => {
    expect(safeEntryPath('.trash/a.md')).toBeNull();
    expect(safeEntryPath('.git/hooks/post-merge')).toBeNull();
    expect(safeEntryPath('.GIT/hooks/post-merge')).toBeNull();
  });

  it('từ chối entry rỗng hoặc chỉ có dấu chấm', () => {
    expect(safeEntryPath('')).toBeNull();
    expect(safeEntryPath('.')).toBeNull();
    expect(safeEntryPath('./')).toBeNull();
  });

  it('bỏ tiền tố ./ mà vẫn giữ phần còn lại', () => {
    expect(safeEntryPath('./Notes/a.md')).toBe('Notes/a.md');
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận nó fail**

Run: `cd server && ../node_modules/.bin/vitest run src/services/archive.test.ts`
Expected: FAIL — không import được `safeEntryPath`.

- [ ] **Step 4: Viết implementation tối thiểu**

```ts
// server/src/services/archive.ts
import path from 'node:path';

export type OnConflict = 'rename' | 'overwrite' | 'skip';

/** Chặn zip bomb: dừng khi vượt một trong hai ngưỡng. */
export const MAX_ENTRIES = 10_000;
export const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

/** Thư mục không bao giờ được ghi đè từ một archive. */
const FORBIDDEN_SEGMENTS = new Set(['.trash', '.git', '.gitmodules', '.gitattributes']);

/**
 * Chuẩn hoá + kiểm tra một đường dẫn entry trong zip. Trả về đường dẫn
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
  if (/^[a-zA-Z]:/.test(norm)) return null; // C:/... của Windows
  const segs = norm.split('/').filter((s) => s.length > 0);
  if (!segs.length) return null;
  for (const s of segs) {
    if (s === '.' || s === '..') return null;
    if (FORBIDDEN_SEGMENTS.has(s.toLowerCase())) return null;
  }
  return segs.join('/');
}

/** Tên thay thế khi trùng: `note.md` → `note (1).md`, tăng dần. */
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
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : '';
  for (let i = 1; i < 1000; i++) {
    const candidate = (dir === '.' ? '' : dir + '/') + `${stem} (${i})${ext}`;
    if (!(await exists(candidate))) return { target: candidate };
  }
  throw new Error(`Không tìm được tên trống cho ${rel}`);
}
```

- [ ] **Step 5: Thêm test cho pickTarget**

```ts
// thêm vào server/src/services/archive.test.ts
import { pickTarget } from './archive.js';

describe('pickTarget', () => {
  const has = (...taken: string[]) => async (p: string) => taken.includes(p);

  it('dùng đúng tên gốc khi chưa trùng', async () => {
    expect(await pickTarget('Notes/a.md', 'rename', has())).toEqual({ target: 'Notes/a.md' });
  });

  it('rename: thêm hậu tố tăng dần, giữ đuôi mở rộng', async () => {
    expect(await pickTarget('Notes/a.md', 'rename', has('Notes/a.md'))).toEqual({ target: 'Notes/a (1).md' });
    expect(await pickTarget('Notes/a.md', 'rename', has('Notes/a.md', 'Notes/a (1).md')))
      .toEqual({ target: 'Notes/a (2).md' });
  });

  it('rename: file không có đuôi mở rộng', async () => {
    expect(await pickTarget('LICENSE', 'rename', has('LICENSE'))).toEqual({ target: 'LICENSE (1)' });
  });

  it('overwrite: giữ nguyên tên', async () => {
    expect(await pickTarget('Notes/a.md', 'overwrite', has('Notes/a.md'))).toEqual({ target: 'Notes/a.md' });
  });

  it('skip: báo bỏ qua', async () => {
    expect(await pickTarget('Notes/a.md', 'skip', has('Notes/a.md'))).toEqual({ skip: true });
  });
});
```

- [ ] **Step 6: Chạy test, xác nhận PASS**

Run: `cd server && ../node_modules/.bin/vitest run src/services/archive.test.ts`
Expected: PASS toàn bộ.

- [ ] **Step 7: Commit**

```bash
git add server/package.json package-lock.json server/src/services/archive.ts server/src/services/archive.test.ts
git commit -m "feat(archive): guard zip-slip + xử lý xung đột tên"
```

---

### Task 3: Nén và giải nén theo stream

**Files:**
- Modify: `server/src/services/archive.ts`
- Test: `server/src/services/archive.test.ts`

**Interfaces:**
- Consumes: `safeEntryPath`, `pickTarget`, `MAX_ENTRIES`, `MAX_TOTAL_BYTES` (Task 2).
- Produces:
  - `createZip(files: {abs: string; rel: string}[], zipPath: string): Promise<{ fileCount: number; bytes: number }>`
  - `interface ExtractResult { written: string[]; skipped: string[]; errors: { path: string; error: string }[] }`
  - `extractZip(zipPath: string, destFolder: string, onConflict: OnConflict): Promise<ExtractResult>`

- [ ] **Step 1: Viết implementation**

```ts
// thêm vào server/src/services/archive.ts
import { createWriteStream, createReadStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import yauzl from 'yauzl';
import * as vault from './vault.js';

export interface ExtractResult {
  written: string[];
  skipped: string[];
  errors: { path: string; error: string }[];
}

/** Nén danh sách file thành zip tại `zipPath`. Stream — RAM phẳng bất kể vault to. */
export async function createZip(
  files: { abs: string; rel: string }[],
  zipPath: string,
): Promise<{ fileCount: number; bytes: number }> {
  const out = createWriteStream(zipPath);
  const zip = archiver('zip', { zlib: { level: 6 } });
  const done = new Promise<void>((resolve, reject) => {
    out.on('close', resolve);
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

/** Bit S_IFLNK trong 16 bit cao của externalFileAttributes (zip tạo trên Unix). */
function isSymlinkEntry(entry: yauzl.Entry): boolean {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  return (mode & 0xf000) === 0xa000;
}

/**
 * Giải nén vào `destFolder` (vault-relative, '' = gốc vault).
 *
 * Entry symlink bị BỎ QUA hoàn toàn: zip lưu được symlink, và một symlink trỏ ra
 * /etc sẽ biến lần ghi kế tiếp thành ghi đè file hệ thống.
 */
export async function extractZip(
  zipPath: string,
  destFolder: string,
  onConflict: OnConflict,
): Promise<ExtractResult> {
  const result: ExtractResult = { written: [], skipped: [], errors: [] };
  const dest = destFolder.replace(/^\/+|\/+$/g, '');
  let entryCount = 0;
  let totalBytes = 0;

  const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, autoClose: true }, (err, zf) => {
      if (err || !zf) reject(err ?? new Error('Không mở được zip'));
      else resolve(zf);
    });
  });

  await new Promise<void>((resolve, reject) => {
    zipfile.on('error', reject);
    zipfile.on('end', resolve);
    zipfile.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        try {
          if (entry.fileName.endsWith('/')) return; // entry thư mục
          if (isSymlinkEntry(entry)) {
            result.skipped.push(`${entry.fileName} (symlink)`);
            return;
          }
          if (++entryCount > MAX_ENTRIES) throw new Error(`Zip vượt ${MAX_ENTRIES} entry`);
          totalBytes += entry.uncompressedSize;
          if (totalBytes > MAX_TOTAL_BYTES) throw new Error('Zip vượt 2 GB sau giải nén');

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
            zipfile.openReadStream(entry, (err, s) => (err || !s ? rej(err ?? new Error('stream lỗi')) : res(s)));
          });
          await pipeline(rs, createWriteStream(abs));
          vault.invalidateStat(picked.target);
          result.written.push(picked.target);
        } catch (e) {
          const msg = (e as Error).message;
          if (msg.includes('vượt')) {
            reject(e); // ngưỡng zip bomb — dừng hẳn
            return;
          }
          result.errors.push({ path: entry.fileName, error: msg });
        } finally {
          zipfile.readEntry();
        }
      })();
    });
    zipfile.readEntry();
  });

  return result;
}
```

- [ ] **Step 2: Viết test round-trip trên vault tạm**

```ts
// thêm vào server/src/services/archive.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import archiver from 'archiver';
import { createWriteStream } from 'node:fs';

let vaultDir: string;
let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(nodePath.join(tmpdir(), 'wo-arc-work-'));
  vaultDir = mkdtempSync(nodePath.join(tmpdir(), 'wo-arc-vault-'));
  process.env.VAULT_PATH = vaultDir;
  process.env.DATA_DIR = mkdtempSync(nodePath.join(tmpdir(), 'wo-arc-data-'));
});
afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(vaultDir, { recursive: true, force: true });
});

/** Tạo zip thô từ danh sách {name, content} để test phía giải nén. */
async function makeZip(zipPath: string, entries: { name: string; content: string }[]): Promise<void> {
  const out = createWriteStream(zipPath);
  const zip = archiver('zip', { zlib: { level: 0 } });
  const done = new Promise<void>((r, j) => { out.on('close', () => r()); zip.on('error', j); });
  zip.pipe(out);
  for (const e of entries) zip.append(e.content, { name: e.name });
  await zip.finalize();
  await done;
}

describe('createZip + extractZip', () => {
  it('round-trip giữ nguyên nội dung, gồm cả tên có dấu tiếng Việt', async () => {
    const { createZip, extractZip } = await import('./archive.js');
    const src = nodePath.join(workDir, 'Ghi chú.md');
    writeFileSync(src, 'xin chào thế giới');
    const zipPath = nodePath.join(workDir, 'a.zip');
    const meta = await createZip([{ abs: src, rel: 'Thư mục/Ghi chú.md' }], zipPath);
    expect(meta.fileCount).toBe(1);

    const res = await extractZip(zipPath, 'Đích', 'rename');
    expect(res.written).toEqual(['Đích/Thư mục/Ghi chú.md']);
    expect(res.errors).toEqual([]);
    const landed = readFileSync(nodePath.join(vaultDir, 'Đích/Thư mục/Ghi chú.md'), 'utf8');
    expect(landed).toBe('xin chào thế giới');
  });

  it('từ chối entry leo ra ngoài vault mà không ghi file nào', async () => {
    const { extractZip } = await import('./archive.js');
    const zipPath = nodePath.join(workDir, 'evil.zip');
    await makeZip(zipPath, [{ name: '../../evil.md', content: 'pwned' }]);
    const res = await extractZip(zipPath, '', 'rename');
    expect(res.written).toEqual([]);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].error).toContain('không hợp lệ');
  });

  it('rename khi trùng thay vì ghi đè', async () => {
    const { extractZip } = await import('./archive.js');
    mkdirSync(nodePath.join(vaultDir, 'Inbox'), { recursive: true });
    writeFileSync(nodePath.join(vaultDir, 'Inbox/a.md'), 'cũ');
    const zipPath = nodePath.join(workDir, 'b.zip');
    await makeZip(zipPath, [{ name: 'a.md', content: 'mới' }]);
    const res = await extractZip(zipPath, 'Inbox', 'rename');
    expect(res.written).toEqual(['Inbox/a (1).md']);
    expect(readFileSync(nodePath.join(vaultDir, 'Inbox/a.md'), 'utf8')).toBe('cũ');
    expect(readFileSync(nodePath.join(vaultDir, 'Inbox/a (1).md'), 'utf8')).toBe('mới');
  });

  it('overwrite ghi đè, skip bỏ qua', async () => {
    const { extractZip } = await import('./archive.js');
    mkdirSync(nodePath.join(vaultDir, 'Inbox'), { recursive: true });
    writeFileSync(nodePath.join(vaultDir, 'Inbox/a.md'), 'cũ');
    const zipPath = nodePath.join(workDir, 'c.zip');
    await makeZip(zipPath, [{ name: 'a.md', content: 'mới' }]);

    const skipped = await extractZip(zipPath, 'Inbox', 'skip');
    expect(skipped.skipped).toEqual(['Inbox/a.md']);
    expect(readFileSync(nodePath.join(vaultDir, 'Inbox/a.md'), 'utf8')).toBe('cũ');

    const over = await extractZip(zipPath, 'Inbox', 'overwrite');
    expect(over.written).toEqual(['Inbox/a.md']);
    expect(readFileSync(nodePath.join(vaultDir, 'Inbox/a.md'), 'utf8')).toBe('mới');
  });
});
```

- [ ] **Step 3: Chạy test**

Run: `cd server && ../node_modules/.bin/vitest run src/services/archive.test.ts`
Expected: PASS toàn bộ.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/archive.ts server/src/services/archive.test.ts
git commit -m "feat(archive): nén/giải nén zip theo stream"
```

---

### Task 4: Kho ticket trong RAM

**Files:**
- Create: `server/src/services/transfer.ts`
- Test: `server/src/services/transfer.test.ts`

**Interfaces:**
- Consumes: `OnConflict`, `ExtractResult` (Task 3).
- Produces:
  - `TTL_MS`, `transferDir(): Promise<string>`, `cleanTransferDir(): Promise<void>`, `startSweeper(): void`
  - `createDownloadTicket(o: { zipPath: string; filename: string; fileCount: number; bytes: number }): DownloadTicket`
  - `createUploadTicket(o: { destFolder: string; onConflict: OnConflict }): UploadTicket`
  - `getTicket(id: string, now?: number): Ticket | null`
  - `claimUploadTicket(id: string, now?: number): UploadTicket | null`
  - `finishUploadTicket(id: string, result: ExtractResult): void`, `failUploadTicket(id: string, error: string): void`
  - `sweep(now?: number): void`

- [ ] **Step 1: Viết test thất bại**

```ts
// server/src/services/transfer.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDownloadTicket, createUploadTicket, getTicket, claimUploadTicket,
  finishUploadTicket, sweep, TTL_MS, __resetForTests,
} from './transfer.js';

beforeEach(() => __resetForTests());

describe('ticket', () => {
  it('sinh token 43 ký tự base64url và tra được', () => {
    const t = createDownloadTicket({ zipPath: '/tmp/a.zip', filename: 'a.zip', fileCount: 1, bytes: 10 });
    expect(t.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getTicket(t.id)?.kind).toBe('download');
  });

  it('hai ticket không trùng token', () => {
    const a = createDownloadTicket({ zipPath: '/tmp/a.zip', filename: 'a.zip', fileCount: 1, bytes: 1 });
    const b = createDownloadTicket({ zipPath: '/tmp/b.zip', filename: 'b.zip', fileCount: 1, bytes: 1 });
    expect(a.id).not.toBe(b.id);
  });

  it('hết hạn sau TTL', () => {
    const t = createDownloadTicket({ zipPath: '/tmp/a.zip', filename: 'a.zip', fileCount: 1, bytes: 1 });
    expect(getTicket(t.id, Date.now() + TTL_MS - 1000)).not.toBeNull();
    expect(getTicket(t.id, Date.now() + TTL_MS + 1000)).toBeNull();
  });

  it('token không tồn tại trả null', () => {
    expect(getTicket('khong-co-that')).toBeNull();
  });

  it('ticket đẩy chỉ dùng được một lần', () => {
    const t = createUploadTicket({ destFolder: 'Inbox', onConflict: 'rename' });
    expect(claimUploadTicket(t.id)).not.toBeNull();
    expect(claimUploadTicket(t.id)).toBeNull();
  });

  it('ticket tải dùng được nhiều lần trong TTL', () => {
    const t = createDownloadTicket({ zipPath: '/tmp/a.zip', filename: 'a.zip', fileCount: 1, bytes: 1 });
    expect(getTicket(t.id)).not.toBeNull();
    expect(getTicket(t.id)).not.toBeNull();
  });

  it('finishUploadTicket ghi kết quả để transfer_status đọc', () => {
    const t = createUploadTicket({ destFolder: '', onConflict: 'rename' });
    claimUploadTicket(t.id);
    finishUploadTicket(t.id, { written: ['a.md'], skipped: [], errors: [] });
    const got = getTicket(t.id);
    expect(got?.kind === 'upload' && got.status).toBe('done');
    expect(got?.kind === 'upload' && got.result?.written).toEqual(['a.md']);
  });

  it('sweep xoá ticket đã hết hạn', () => {
    const t = createDownloadTicket({ zipPath: '/tmp/a.zip', filename: 'a.zip', fileCount: 1, bytes: 1 });
    sweep(Date.now() + TTL_MS + 1000);
    expect(getTicket(t.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `cd server && ../node_modules/.bin/vitest run src/services/transfer.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Viết implementation**

```ts
// server/src/services/transfer.ts
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { config } from '../config.js';
import type { OnConflict, ExtractResult } from './archive.js';

/**
 * Ticket cho luồng truyền file qua HTTP ngoài luồng MCP.
 *
 * Sống trong RAM chứ không ghi settings.json: chúng ephemeral (TTL 30 phút),
 * mất khi restart là chấp nhận được, và giữ settings.json sạch.
 */
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

/** Token 256-bit: entropy đủ lớn nên tra Map trực tiếp là an toàn. */
function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function createDownloadTicket(o: {
  zipPath: string; filename: string; fileCount: number; bytes: number;
}): DownloadTicket {
  const t: DownloadTicket = { kind: 'download', id: newToken(), ...o, expiresAt: Date.now() + TTL_MS };
  tickets.set(t.id, t);
  return t;
}

export function createUploadTicket(o: { destFolder: string; onConflict: OnConflict }): UploadTicket {
  const t: UploadTicket = {
    kind: 'upload', id: newToken(), ...o,
    status: 'pending', claimed: false, expiresAt: Date.now() + TTL_MS,
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

/** Ticket đẩy dùng đúng một lần: lần claim thứ hai trả null. */
export function claimUploadTicket(id: string, now: number = Date.now()): UploadTicket | null {
  const t = getTicket(id, now);
  if (!t || t.kind !== 'upload' || t.claimed) return null;
  t.claimed = true;
  return t;
}

export function finishUploadTicket(id: string, result: ExtractResult): void {
  const t = tickets.get(id);
  if (t?.kind === 'upload') { t.status = 'done'; t.result = result; }
}

export function failUploadTicket(id: string, error: string): void {
  const t = tickets.get(id);
  if (t?.kind === 'upload') { t.status = 'error'; t.error = error; t.claimed = false; }
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
  sweeper.unref();
}

export async function transferDir(): Promise<string> {
  const dir = path.join(config.dataDir, 'transfer');
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** Dọn sạch lúc boot: ticket sống trong RAM nên mọi zip còn sót đều mồ côi. */
export async function cleanTransferDir(): Promise<void> {
  const dir = path.join(config.dataDir, 'transfer');
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
}

/** Chỉ dùng trong test. */
export function __resetForTests(): void {
  tickets.clear();
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `cd server && ../node_modules/.bin/vitest run src/services/transfer.test.ts`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/transfer.ts server/src/services/transfer.test.ts
git commit -m "feat(transfer): kho ticket trong RAM có TTL"
```

---

### Task 5: Guard SSRF + tải zip về đĩa

**Files:**
- Create: `server/src/services/fetchzip.ts`
- Test: `server/src/services/fetchzip.test.ts`

**Interfaces:**
- Produces: `isBlockedAddress(ip: string): boolean`; `fetchZipToFile(url: string, destPath: string): Promise<{ bytes: number }>`; `MAX_FETCH_BYTES`.

- [ ] **Step 1: Viết test thất bại**

```ts
// server/src/services/fetchzip.test.ts
import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from './fetchzip.js';

describe('isBlockedAddress', () => {
  it('chặn loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.9.9.9')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('chặn link-local, gồm cả endpoint metadata của cloud', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
  });

  it('chặn 0.0.0.0 và địa chỉ IPv4-mapped của loopback', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('CHO PHÉP dải LAN riêng — hai vault self-hosted thường cùng mạng nội bộ', () => {
    expect(isBlockedAddress('192.168.1.10')).toBe(false);
    expect(isBlockedAddress('10.0.0.5')).toBe(false);
    expect(isBlockedAddress('172.16.0.1')).toBe(false);
  });

  it('cho phép IP public', () => {
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `cd server && ../node_modules/.bin/vitest run src/services/fetchzip.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 3: Viết implementation**

```ts
// server/src/services/fetchzip.ts
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import { createWriteStream, promises as fs } from 'node:fs';
import type { LookupAddress } from 'node:dns';

export const MAX_FETCH_BYTES = 500 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** Magic bytes của mọi file zip hợp lệ: "PK\x03\x04". */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Guard SSRF. Chặn loopback + link-local (gồm 169.254.169.254 — endpoint
 * metadata của cloud provider).
 *
 * KHÔNG chặn dải LAN riêng (10/8, 172.16/12, 192.168/16): hai vault self-hosted
 * rất có thể cùng mạng nội bộ, chặn là hỏng đúng use case chính. Người gọi đã
 * phải cầm MCP key hợp lệ nên đây không phải endpoint mở.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 127) return true;            // loopback
    if (a === 0) return true;              // "this host"
    if (a === 169 && b === 254) return true; // link-local + metadata cloud
    return false;
  }
  if (addr === '::' || addr === '::1') return true;
  if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
      addr.startsWith('fea') || addr.startsWith('feb')) return true; // fe80::/10
  return false;
}

/** dns.lookup có kiểm tra IP — chạy tại thời điểm connect nên chống được DNS rebinding. */
const guardedLookup: typeof dns.lookup = ((hostname, options, cb) => {
  const callback = (typeof options === 'function' ? options : cb) as (
    err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number,
  ) => void;
  const opts = typeof options === 'function' ? {} : options;
  dns.lookup(hostname, opts as dns.LookupOneOptions, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address) ? address : [{ address: address as string, family: family ?? 4 }];
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        return callback(Object.assign(new Error(`Địa chỉ bị chặn: ${a.address}`), { code: 'EBLOCKED' }), '', 4);
      }
    }
    callback(null, address, family);
  });
}) as typeof dns.lookup;

/**
 * Tải zip từ `url` về `destPath`. Xác thực là zip bằng magic bytes chứ không
 * tin Content-Type. Theo tối đa 3 redirect, kiểm IP lại ở TỪNG hop.
 */
export async function fetchZipToFile(url: string, destPath: string): Promise<{ bytes: number }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Chỉ hỗ trợ http/https, nhận được ${u.protocol}`);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.get(u, { lookup: guardedLookup }, resolve);
      req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('Hết thời gian kết nối')));
      req.on('error', reject);
    });

    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume();
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`Tải thất bại: HTTP ${res.statusCode}`);
    }

    const out = createWriteStream(destPath);
    let bytes = 0;
    let magicOk: boolean | null = null;
    let head = Buffer.alloc(0);
    try {
      await new Promise<void>((resolve, reject) => {
        res.on('data', (chunk: Buffer) => {
          if (magicOk === null) {
            head = Buffer.concat([head, chunk]);
            if (head.length >= 4) {
              magicOk = head.subarray(0, 4).equals(ZIP_MAGIC);
              if (!magicOk) {
                res.destroy();
                reject(new Error('Nội dung tải về không phải file zip'));
                return;
              }
            }
          }
          bytes += chunk.length;
          if (bytes > MAX_FETCH_BYTES) {
            res.destroy();
            reject(new Error(`File vượt ${MAX_FETCH_BYTES} byte`));
            return;
          }
          if (!out.write(chunk)) { res.pause(); out.once('drain', () => res.resume()); }
        });
        res.on('error', reject);
        res.on('end', () => out.end(resolve));
      });
    } catch (e) {
      out.destroy();
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw e;
    }
    if (magicOk !== true) {
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw new Error('Nội dung tải về không phải file zip');
    }
    return { bytes };
  }
  throw new Error(`Vượt quá ${MAX_REDIRECTS} redirect`);
}
```

- [ ] **Step 4: Chạy test, xác nhận PASS**

Run: `cd server && ../node_modules/.bin/vitest run src/services/fetchzip.test.ts`
Expected: PASS toàn bộ.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/fetchzip.ts server/src/services/fetchzip.test.ts
git commit -m "feat(transfer): guard SSRF + tải zip theo stream"
```

---

### Task 6: Route `/transfer/*`

**Files:**
- Create: `server/src/routes/transfer.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: Task 3 (`extractZip`), Task 4 (ticket store).
- Produces: `transferRouter`; `collectVaultFiles(opts): Promise<{abs,rel}[]>` và `reindexAfterExtract(written): void` được Task 7 dùng lại.

- [ ] **Step 1: Viết route**

```ts
// server/src/routes/transfer.ts
/**
 * Truyền file hàng loạt qua HTTP, NGOÀI luồng MCP — bytes không bao giờ đi qua
 * context của model. Không auth: token 256-bit nằm trong URL, giống /share.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs, createReadStream } from 'node:fs';
import { asyncHandler } from '../middleware/error.js';
import { createSlidingWindowCounter } from '../lib/slidingwindow.js';
import { extractZip, type ExtractResult } from '../services/archive.js';
import {
  getTicket, claimUploadTicket, finishUploadTicket, failUploadTicket, transferDir,
} from '../services/transfer.js';
import { escapeHtml } from '../services/renderhtml.js';
import { qmd } from '../services/search.js';
import { buildLinkGraph } from '../services/links.js';
import { broadcast } from '../services/realtime.js';
import { MAX_FETCH_BYTES } from '../services/fetchzip.js';

export const transferRouter = Router();

const rateOk = createSlidingWindowCounter(60_000);
const RATE_LIMIT_PER_MIN = 60;
transferRouter.use((req, res, next) => {
  if (!rateOk(req.ip ?? 'unknown', RATE_LIMIT_PER_MIN)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  next();
});

/** Sau khi giải nén: cập nhật index tìm kiếm + đồ thị liên kết MỘT LẦN cho cả mẻ. */
export function reindexAfterExtract(written: string[]): void {
  for (const rel of written) {
    if (rel.toLowerCase().endsWith('.md')) void qmd.upsert(rel).catch(() => {});
  }
  void buildLinkGraph().catch(() => {});
  broadcast({ type: 'tree-changed' });
}

transferRouter.get('/d/:token', asyncHandler(async (req: Request, res: Response) => {
  const t = getTicket(req.params.token);
  if (!t || t.kind !== 'download') {
    res.status(404).json({ error: 'ticket_not_found_or_expired' });
    return;
  }
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(t.filename)}`);
  res.setHeader('Content-Length', String(t.bytes));
  createReadStream(t.zipPath).pipe(res);
}));

function uploadPage(nonce: string, token: string, body: string): string {
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Tải file lên vault</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.6}
#drop{border:2px dashed #999;border-radius:.5rem;padding:3rem 1rem;text-align:center;cursor:pointer}
#drop.over{border-color:#3b82f6;background:#eff6ff}
ul{max-height:20rem;overflow:auto}code{word-break:break-all}
</style></head><body>${body}
<script nonce="${nonce}">
const drop=document.getElementById('drop'),inp=document.getElementById('f'),out=document.getElementById('out');
if(drop){
  drop.onclick=()=>inp.click();
  drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')};
  drop.ondragleave=()=>drop.classList.remove('over');
  drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])send(e.dataTransfer.files[0])};
  inp.onchange=()=>{if(inp.files[0])send(inp.files[0])};
}
async function send(file){
  out.textContent='Đang tải lên '+file.name+'…';
  const fd=new FormData();fd.append('file',file);
  try{
    const r=await fetch(location.pathname,{method:'POST',body:fd});
    const j=await r.json();
    if(!r.ok){out.textContent='Lỗi: '+(j.error||r.status);return}
    out.innerHTML='<b>Đã ghi '+j.written.length+' file.</b>'+
      (j.skipped.length?'<p>Bỏ qua '+j.skipped.length+'.</p>':'')+
      (j.errors.length?'<p>Lỗi '+j.errors.length+'.</p>':'')+
      '<ul>'+j.written.map(p=>'<li><code>'+p.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]))+'</code></li>').join('')+'</ul>';
    drop.style.display='none';
  }catch(e){out.textContent='Lỗi: '+e.message}
}
</script></body></html>`;
}

transferRouter.get('/u/:token', asyncHandler(async (req: Request, res: Response) => {
  const nonce = String(res.locals.cspNonce ?? '');
  const t = getTicket(req.params.token);
  if (!t || t.kind !== 'upload') {
    res.status(404).type('html').send(uploadPage(nonce, '', '<h1>Link không tồn tại hoặc đã hết hạn</h1>'));
    return;
  }
  if (t.claimed && t.status !== 'error') {
    res.type('html').send(uploadPage(nonce, t.id, '<h1>Link này đã được dùng</h1>'));
    return;
  }
  const dest = t.destFolder ? escapeHtml(t.destFolder) : '(gốc vault)';
  res.type('html').send(uploadPage(nonce, t.id,
    `<h1>Tải file zip lên vault</h1>
     <p>Đích: <code>${dest}</code> — trùng tên thì <code>${t.onConflict}</code>.</p>
     <div id="drop">Kéo file <b>.zip</b> vào đây, hoặc bấm để chọn</div>
     <input id="f" type="file" accept=".zip,application/zip" hidden>
     <div id="out"></div>`));
}));

const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => { void transferDir().then((d) => cb(null, d), (e) => cb(e, '')); },
    filename: (_req, _file, cb) => cb(null, `up-${Date.now()}-${Math.round(Math.random() * 1e9)}.zip`),
  }),
  limits: { fileSize: MAX_FETCH_BYTES, files: 1 },
});

transferRouter.post('/u/:token', uploadZip.single('file'), asyncHandler(async (req: Request, res: Response) => {
  const cleanup = async (): Promise<void> => {
    if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
  };
  const t = claimUploadTicket(req.params.token);
  if (!t) {
    await cleanup();
    res.status(404).json({ error: 'ticket_not_found_expired_or_used' });
    return;
  }
  if (!req.file) {
    failUploadTicket(t.id, 'thiếu file');
    res.status(400).json({ error: 'file required' });
    return;
  }
  let result: ExtractResult;
  try {
    result = await extractZip(req.file.path, t.destFolder, t.onConflict);
  } catch (e) {
    await cleanup();
    failUploadTicket(t.id, (e as Error).message);
    res.status(400).json({ error: (e as Error).message });
    return;
  }
  await cleanup();
  finishUploadTicket(t.id, result);
  reindexAfterExtract(result.written);
  res.json(result);
}));
```

- [ ] **Step 2: Mount route và loại `/transfer` khỏi SPA catch-all**

Trong `server/src/index.ts`:

```ts
import { transferRouter } from './routes/transfer.js';
import { cleanTransferDir, startSweeper } from './services/transfer.js';
```

Thêm ngay sau dòng `app.use('/share', sharePageRouter);`:

```ts
app.use('/transfer', transferRouter); // truyền file zip (NO auth, token trong URL)
```

Sửa SPA catch-all — **bắt buộc**, nếu không `app.get('*')` sẽ trả HTML cho `/transfer/*` đúng như cái bẫy OAuth đã ghi ở `docs/MCP.md`:

```ts
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public') || req.path.startsWith('/mcp') || req.path.startsWith('/transfer')) return next();
      res.sendFile(path.join(publicDir, 'index.html'));
    });
```

Thêm vào phần boot, cạnh `await initSearch();`:

```ts
  // Ticket sống trong RAM nên mọi zip còn sót từ lần chạy trước đều mồ côi.
  await cleanTransferDir();
  startSweeper();
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: không lỗi.

- [ ] **Step 4: Commit**

```bash
git add server/src/routes/transfer.ts server/src/index.ts
git commit -m "feat(transfer): route /transfer/* cho tải và đẩy zip"
```

---

### Task 7: Bốn tool MCP

**Files:**
- Modify: `server/src/services/mcptools.ts`
- Modify: `server/src/routes/mcp.ts`

**Interfaces:**
- Consumes: Task 3–6.
- Produces: `createMcpServer(baseUrl: string)` — chữ ký đổi, `routes/mcp.ts` phải truyền vào.

- [ ] **Step 1: Đổi chữ ký `createMcpServer` và truyền baseUrl**

`server/src/routes/mcp.ts` — thay `createMcpServer()` bằng:

```ts
  const server = createMcpServer(`${req.protocol}://${req.get('host')}`);
```

- [ ] **Step 2: Thêm 4 tool vào `mcptools.ts`**

```ts
// thêm import
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createZip, extractZip, type OnConflict } from './archive.js';
import {
  createDownloadTicket, createUploadTicket, getTicket, transferDir, TTL_MS,
} from './transfer.js';
import { fetchZipToFile } from './fetchzip.js';
import { reindexAfterExtract } from '../routes/transfer.js';

const MAX_DOWNLOAD_FILES = 5_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const CONFLICT = z.enum(['rename', 'overwrite', 'skip']);

/** Làm phẳng cây vault thành danh sách file. listTree đã bỏ dotfile (.obsidian,
 *  .trash, .git) và node_modules — đúng ngữ nghĩa loại trừ ta muốn. */
function flattenTree(node: vault.TreeNode, out: string[] = []): string[] {
  if (node.type === 'file' && node.path) out.push(node.path);
  for (const c of node.children ?? []) flattenTree(c, out);
  return out;
}

async function collectFiles(paths?: string[], folder?: string): Promise<string[]> {
  if (paths?.length) {
    const missing: string[] = [];
    for (const p of paths) if (!(await vault.exists(p))) missing.push(p);
    if (missing.length) throw new Error(`Không tìm thấy: ${missing.join(', ')}`);
    return paths;
  }
  const all = flattenTree(await vault.listTree());
  const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
  return f ? all.filter((p) => p === f || p.startsWith(f + '/')) : all;
}
```

Bên trong `createMcpServer(baseUrl: string)`, thêm:

```ts
  server.registerTool(
    'download_files',
    {
      description:
        'Đóng gói file trong vault thành một file ZIP và trả về LINK TẢI tạm thời (30 phút). ' +
        'Chọn theo paths (danh sách đường dẫn) và/hoặc folder (tiền tố); bỏ trống cả hai = cả vault. ' +
        'Bỏ qua .trash và dotfile (.obsidian, .git). Link này dùng được cho upload_from_url của vault khác ' +
        'để chuyển file giữa hai vault mà không tốn token.',
      inputSchema: {
        paths: z.array(z.string()).optional(),
        folder: z.string().optional(),
      },
      annotations: RO,
    },
    ({ paths, folder }) =>
      run(async () => {
        const rels = await collectFiles(paths, folder);
        if (!rels.length) throw new Error('Không có file nào khớp lựa chọn');
        if (rels.length > MAX_DOWNLOAD_FILES)
          throw new Error(`${rels.length} file, vượt giới hạn ${MAX_DOWNLOAD_FILES}`);
        const entries: { abs: string; rel: string }[] = [];
        let raw = 0;
        for (const rel of rels) {
          const abs = await vault.resolveInVault(rel);
          raw += (await fsp.stat(abs)).size;
          if (raw > MAX_DOWNLOAD_BYTES)
            throw new Error(`Tổng dung lượng vượt ${MAX_DOWNLOAD_BYTES} byte`);
          entries.push({ abs, rel });
        }
        const dir = await transferDir();
        const name = `${(folder ?? '').replace(/[^\p{L}\p{N} _-]/gu, '') || 'vault'}.zip`;
        const zipPath = path.join(dir, `dl-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        const meta = await createZip(entries, zipPath);
        const t = createDownloadTicket({ zipPath, filename: name, ...meta });
        return {
          url: `${baseUrl}/transfer/d/${t.id}`,
          fileCount: meta.fileCount,
          bytes: meta.bytes,
          expiresAt: new Date(t.expiresAt).toISOString(),
          hint: 'Đưa url này cho upload_from_url của vault đích để chuyển tự động.',
        };
      }),
  );

  server.registerTool(
    'upload_from_url',
    {
      description:
        'Tải một file ZIP từ url rồi GIẢI NÉN thẳng vào vault này. Dùng cùng link do download_files ' +
        'của vault khác sinh ra để chuyển file giữa hai vault hoàn toàn tự động (bytes không qua context). ' +
        'Chạy đồng bộ, trả ngay danh sách file đã ghi. Thao tác phá hủy.',
      inputSchema: {
        url: z.string().url(),
        dest_folder: z.string().optional(),
        on_conflict: CONFLICT.optional(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ url, dest_folder, on_conflict }) =>
      run(async () => {
        const dir = await transferDir();
        const tmp = path.join(dir, `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        try {
          const { bytes } = await fetchZipToFile(url, tmp);
          const result = await extractZip(tmp, dest_folder ?? '', (on_conflict ?? 'rename') as OnConflict);
          reindexAfterExtract(result.written);
          return { downloadedBytes: bytes, ...result };
        } finally {
          await fsp.rm(tmp, { force: true }).catch(() => {});
        }
      }),
  );

  server.registerTool(
    'upload_files',
    {
      description:
        'Tạo link để BẠN tải file zip lên vault bằng trình duyệt — tool này CHƯA ghi gì cả, ' +
        'nó chỉ trả về một URL có hạn 30 phút, dùng đúng một lần. Người dùng phải tự mở URL đó và ' +
        'kéo file zip vào. Dùng khi file nằm trên máy người dùng. Nếu nguồn là một vault khác thì ' +
        'dùng upload_from_url (tự động, không cần thao tác tay). Sau khi người dùng báo đã tải xong, ' +
        'gọi transfer_status với ticket trả về ở đây để biết kết quả.',
      inputSchema: {
        dest_folder: z.string().optional(),
        on_conflict: CONFLICT.optional(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ dest_folder, on_conflict }) =>
      run(async () => {
        const t = createUploadTicket({
          destFolder: (dest_folder ?? '').replace(/^\/+|\/+$/g, ''),
          onConflict: (on_conflict ?? 'rename') as OnConflict,
        });
        return {
          url: `${baseUrl}/transfer/u/${t.id}`,
          ticket: t.id,
          destFolder: t.destFolder || '(gốc vault)',
          onConflict: t.onConflict,
          expiresAt: new Date(t.expiresAt).toISOString(),
          hint: `Người dùng mở link này và kéo file zip vào. Hết hạn sau ${TTL_MS / 60000} phút.`,
        };
      }),
  );

  server.registerTool(
    'transfer_status',
    {
      description:
        'Xem kết quả của một ticket do upload_files tạo: đã ghi file nào, bỏ qua gì, lỗi gì. ' +
        'Gọi sau khi người dùng báo đã kéo file zip lên xong.',
      inputSchema: { ticket: z.string() },
      annotations: RO,
    },
    ({ ticket }) =>
      run(async () => {
        const t = getTicket(ticket);
        if (!t) throw new Error('Ticket không tồn tại hoặc đã hết hạn');
        if (t.kind !== 'upload') throw new Error('Ticket này là ticket tải, không có trạng thái ghi');
        return { status: t.status, destFolder: t.destFolder, result: t.result, error: t.error };
      }),
  );
```

- [ ] **Step 3: Typecheck + toàn bộ unit test**

Run: `npm run typecheck && cd server && ../node_modules/.bin/vitest run`
Expected: không lỗi type, mọi test PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/mcptools.ts server/src/routes/mcp.ts
git commit -m "feat(mcp): 4 tool truyền file zip vào/ra vault"
```

---

### Task 8: E2E round-trip hai vault

**Files:**
- Modify: `server/scripts/verify-mcp.ts`

- [ ] **Step 1: Tổng quát hoá script để chạy được HAI server**

Đổi phần dựng server thành một hàm nhận `(port, dataDir, vaultDir)` trả `{ child, key, base }`, rồi trong `main()` dựng server A (port 18899) và server B (port 18898), mỗi cái một vault tạm riêng.

- [ ] **Step 2: Sửa số tool mong đợi**

```ts
    check('listTools trả 15 tool', tools.tools.length === 15, tools.tools.map((t) => t.name));
```

- [ ] **Step 3: Thêm kịch bản round-trip vào cuối, TRƯỚC `await client.close()`**

```ts
    // --- round-trip A → B: seed vault A với 1 file text có dấu + 1 file binary ---
    const binPath = 'Ảnh/mẫu.bin';
    const binBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42]);
    await fsp.mkdir(path.join(vaultDirA, 'Ảnh'), { recursive: true });
    await fsp.writeFile(path.join(vaultDirA, binPath), binBytes);
    await client.callTool({ name: 'write_note', arguments: { path: 'Chuyển/Ghi chú có dấu.md', content: 'nội dung tiếng Việt', base_version: '' } });

    const dl = await client.callTool({ name: 'download_files', arguments: {} });
    const dlJson = JSON.parse(textOf(dl));
    check('download_files trả link + đếm đúng file', typeof dlJson.url === 'string' && dlJson.fileCount >= 2, dlJson);

    // Link tải phải dùng được bằng HTTP thuần (không auth)
    const zipRes = await fetch(dlJson.url);
    check('link tải trả 200 + application/zip',
      zipRes.ok && (zipRes.headers.get('content-type') ?? '').includes('zip'), zipRes.status);

    const clientB = await connectTo(BASE_B, keyB);
    const up = await clientB.callTool({ name: 'upload_from_url', arguments: { url: dlJson.url } });
    const upJson = JSON.parse(textOf(up));
    check('upload_from_url ghi được file sang vault B', Array.isArray(upJson.written) && upJson.written.length >= 2, upJson);
    check('upload_from_url không có lỗi entry', upJson.errors.length === 0, upJson.errors);

    // So khớp BYTE từng file, gồm file binary và tên có dấu
    const gotBin = await fsp.readFile(path.join(vaultDirB, binPath));
    check('file binary khớp byte sau khi chuyển', gotBin.equals(binBytes), { got: [...gotBin] });
    const gotMd = await fsp.readFile(path.join(vaultDirB, 'Chuyển/Ghi chú có dấu.md'), 'utf8');
    check('file tên có dấu khớp nội dung', gotMd === 'nội dung tiếng Việt', gotMd);

    // --- upload_files trả link kéo-thả, và trang đó phải là HTML chứ không phải SPA ---
    const uf = await clientB.callTool({ name: 'upload_files', arguments: { dest_folder: 'Kéo thả' } });
    const ufJson = JSON.parse(textOf(uf));
    check('upload_files trả url + ticket', typeof ufJson.url === 'string' && typeof ufJson.ticket === 'string', ufJson);
    const pageRes = await fetch(ufJson.url);
    const pageHtml = await pageRes.text();
    check('trang kéo-thả render đúng (không bị SPA catch-all nuốt)',
      pageRes.ok && pageHtml.includes('Kéo file'), pageHtml.slice(0, 200));

    // POST zip thật lên đúng ticket đó
    const zipBuf = Buffer.from(await (await fetch(dlJson.url)).arrayBuffer());
    const fd = new FormData();
    fd.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'a.zip');
    const postRes = await fetch(ufJson.url, { method: 'POST', body: fd });
    const postJson = await postRes.json();
    check('POST zip lên ticket ghi được file', postRes.ok && postJson.written.length >= 2, postJson);

    const st = await clientB.callTool({ name: 'transfer_status', arguments: { ticket: ufJson.ticket } });
    check('transfer_status báo done', textOf(st).includes('"done"'), textOf(st));

    // ticket dùng một lần: POST lần hai phải bị từ chối
    const fd2 = new FormData();
    fd2.append('file', new Blob([zipBuf], { type: 'application/zip' }), 'a.zip');
    const twice = await fetch(ufJson.url, { method: 'POST', body: fd2 });
    check('ticket đẩy chỉ dùng được một lần (lần 2 → 404)', twice.status === 404, twice.status);

    // token bịa → 404
    const bogus = await fetch(`${BASE_B}/transfer/d/khongcothat`);
    check('token tải bịa → 404', bogus.status === 404, bogus.status);

    await clientB.close();
```

- [ ] **Step 4: Chạy e2e**

Run: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts`
Expected: `0 failed`.

- [ ] **Step 5: Commit**

```bash
git add server/scripts/verify-mcp.ts
git commit -m "test(mcp): e2e round-trip chuyển file giữa hai vault"
```

---

### Task 9: Tài liệu + gộp về main + deploy

**Files:**
- Modify: `docs/MCP.md`, `IMPLEMENTATION_PLAN.md`

- [ ] **Step 1: Cập nhật `docs/MCP.md`**

Đổi "Tools (11)" thành "Tools (15)", liệt kê 4 tool mới, mô tả `/transfer/*` (không auth, token trong URL, TTL 30 phút) và **thêm cảnh báo `/transfer` phải nằm trong danh sách loại trừ của SPA catch-all** — cùng loại bẫy với mục OAuth-discovery đã có.

- [ ] **Step 2: Đánh dấu hoàn thành trong `IMPLEMENTATION_PLAN.md`**

Đổi các checkbox sang `[x]`, cập nhật "Cập nhật lần cuối" và thêm dòng nhật ký tiến độ.

- [ ] **Step 3: Chạy lại toàn bộ kiểm chứng trước khi gộp**

```bash
npm run typecheck
cd server && ../node_modules/.bin/vitest run
cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts
npm run build
```
Expected: tất cả xanh. **Không được đánh `[x]` hay gộp nếu bất kỳ lệnh nào đỏ.**

- [ ] **Step 4: Commit tài liệu**

```bash
git add docs/MCP.md IMPLEMENTATION_PLAN.md
git commit -m "docs: MCP transfer tools + cập nhật tiến độ"
```

- [ ] **Step 5: Gộp về main ở checkout gốc và push**

Nhánh worktree bị xoá khi session đóng, nên bắt buộc gộp về `main` ở checkout gốc rồi push lên `origin`.

```bash
git -C /Users/henry/Documents/Projects/webobsidian status   # ĐỌC KỸ: có MERGE_HEAD thì DỪNG
git -C /Users/henry/Documents/Projects/webobsidian fetch origin
git -C /Users/henry/Documents/Projects/webobsidian checkout main
git -C /Users/henry/Documents/Projects/webobsidian merge --ff-only <branch>
git -C /Users/henry/Documents/Projects/webobsidian push origin main
```

- [ ] **Step 6: Deploy**

Đọc `../_deployments/webobsidian-web.md` để lấy host + lệnh deploy thật (repo này public — không dán chúng vào bất kỳ file nào ở đây). Sau khi deploy, xác minh trên prod: `/healthz` xanh, và `listTools` qua MCP trả 15 tool.

---

## Self-Review

**Spec coverage:** §3.1 luồng A→B → Task 7 (`download_files` + `upload_from_url`) + Task 8. §3.2 luồng kéo-thả → Task 6 + 7. §3.3 thành phần → Task 2–6. §4 bốn tool → Task 7. §5.1 ticket → Task 4. §5.2 zip-slip → Task 2. §5.3 zip bomb → Task 2 (hằng số) + Task 3 (thực thi). §5.4 SSRF → Task 5. §5.5 diskStorage → Task 6. §6 xung đột + reindex → Task 2 (`pickTarget`), Task 3, Task 6 (`reindexAfterExtract`). §7 kiểm chứng → Task 2, 3, 4, 5, 8. Tài liệu → Task 1 và Task 9.

**Rủi ro đã lường:** SPA catch-all nuốt `/transfer/*` (Task 6 Step 2, nêu lại ở Task 9 Step 1); `createMcpServer` đổi chữ ký nên `routes/mcp.ts` phải sửa cùng lúc (Task 7 Step 1); `reindexAfterExtract` export từ `routes/transfer.ts` và được `services/mcptools.ts` import — ngược chiều phụ thuộc thường thấy, chấp nhận vì tránh trùng lặp; nếu vòng lặp import gây lỗi thì chuyển hàm đó xuống `services/transfer.ts`.
