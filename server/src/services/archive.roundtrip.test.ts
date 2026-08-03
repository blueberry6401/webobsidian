/**
 * Round-trip thật của archive.ts trên một vault tạm.
 *
 * `config.ts` đọc VAULT_PATH/DATA_DIR **lúc module được nạp**, mà import ESM thì
 * được hoist lên trước thân module — nên env phải được đặt trong `vi.hoisted`,
 * không thể đặt ở `beforeEach`.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';
import { buildRawZip, type RawEntry } from './rawzip.js';

const dirs = vi.hoisted(() => {
  const { mkdtempSync: mk } = require('node:fs') as typeof import('node:fs');
  const { tmpdir: td } = require('node:os') as typeof import('node:os');
  const p = require('node:path') as typeof import('node:path');
  const vaultDir = mk(p.join(td(), 'wo-arc-vault-'));
  const dataDir = mk(p.join(td(), 'wo-arc-data-'));
  process.env.VAULT_PATH = vaultDir;
  process.env.DATA_DIR = dataDir;
  return { vaultDir, dataDir };
});

const { createZip, extractZip, MAX_ENTRIES } = await import('./archive.js');

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(nodePath.join(tmpdir(), 'wo-arc-work-'));
  for (const e of readdirSync(dirs.vaultDir)) {
    rmSync(nodePath.join(dirs.vaultDir, e), { recursive: true, force: true });
  }
});

afterAll(() => {
  rmSync(dirs.vaultDir, { recursive: true, force: true });
  rmSync(dirs.dataDir, { recursive: true, force: true });
});

/**
 * Ghi ZIP dựng thủ công. KHÔNG dùng `archiver` ở đây: nó tự chuẩn hoá tên entry
 * (`../../x` thành `x`) nên test zip-slip sẽ xanh mà guard chưa hề chạy.
 */
function makeZip(zipPath: string, entries: RawEntry[]): void {
  writeFileSync(zipPath, buildRawZip(entries));
}

describe('createZip + extractZip', () => {
  it('round-trip giữ nguyên nội dung, gồm cả tên có dấu tiếng Việt', async () => {
    const src = nodePath.join(workDir, 'ghichu.md');
    writeFileSync(src, 'xin chào thế giới');
    const zipPath = nodePath.join(workDir, 'a.zip');
    const meta = await createZip([{ abs: src, rel: 'Thư mục/Ghi chú.md' }], zipPath);
    expect(meta.fileCount).toBe(1);
    expect(meta.bytes).toBeGreaterThan(0);

    const res = await extractZip(zipPath, 'Đích', 'rename');
    expect(res.errors).toEqual([]);
    expect(res.written).toEqual(['Đích/Thư mục/Ghi chú.md']);
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Đích/Thư mục/Ghi chú.md'), 'utf8')).toBe(
      'xin chào thế giới',
    );
  });

  it('giữ nguyên byte của file nhị phân', async () => {
    const bin = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x00]);
    const src = nodePath.join(workDir, 'mau.bin');
    writeFileSync(src, bin);
    const zipPath = nodePath.join(workDir, 'bin.zip');
    await createZip([{ abs: src, rel: 'Ảnh/mẫu.bin' }], zipPath);

    const res = await extractZip(zipPath, '', 'rename');
    expect(res.written).toEqual(['Ảnh/mẫu.bin']);
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Ảnh/mẫu.bin')).equals(bin)).toBe(true);
  });

  it('từ chối cả archive khi có entry leo ra ngoài vault, không ghi file nào', async () => {
    // yauzl có validateFileName riêng, chặn `..`/đường dẫn tuyệt đối/`\` ở tầng
    // thấp hơn safeEntryPath và huỷ luôn cả archive. Fail-closed như vậy là đúng
    // cho một zip rõ ràng thù địch. safeEntryPath vẫn cần thiết vì yauzl KHÔNG
    // chặn `.git`/`.trash` (xem test kế tiếp).
    const zipPath = nodePath.join(workDir, 'evil.zip');
    makeZip(zipPath, [{ name: '../../evil.md', content: 'pwned' }]);
    await expect(extractZip(zipPath, '', 'rename')).rejects.toThrow(/relative path|\.\./);
    expect(readdirSync(dirs.vaultDir)).toEqual([]);
  });

  it('từ chối entry nhắm vào .git — chốt chặn của safeEntryPath, yauzl cho lọt', async () => {
    const zipPath = nodePath.join(workDir, 'githook.zip');
    makeZip(zipPath, [{ name: '.git/hooks/post-merge', content: '#!/bin/sh\nid' }]);
    const res = await extractZip(zipPath, '', 'overwrite');
    expect(res.written).toEqual([]);
    expect(res.errors).toHaveLength(1);
  });

  it('rename khi trùng thay vì ghi đè', async () => {
    mkdirSync(nodePath.join(dirs.vaultDir, 'Inbox'), { recursive: true });
    writeFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a.md'), 'cũ');
    const zipPath = nodePath.join(workDir, 'b.zip');
    makeZip(zipPath, [{ name: 'a.md', content: 'mới' }]);

    const res = await extractZip(zipPath, 'Inbox', 'rename');
    expect(res.written).toEqual(['Inbox/a (1).md']);
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a.md'), 'utf8')).toBe('cũ');
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a (1).md'), 'utf8')).toBe('mới');
  });

  it('skip bỏ qua file đã có, overwrite thì ghi đè', async () => {
    mkdirSync(nodePath.join(dirs.vaultDir, 'Inbox'), { recursive: true });
    writeFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a.md'), 'cũ');
    const zipPath = nodePath.join(workDir, 'c.zip');
    makeZip(zipPath, [{ name: 'a.md', content: 'mới' }]);

    const skipped = await extractZip(zipPath, 'Inbox', 'skip');
    expect(skipped.skipped).toEqual(['Inbox/a.md']);
    expect(skipped.written).toEqual([]);
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a.md'), 'utf8')).toBe('cũ');

    const over = await extractZip(zipPath, 'Inbox', 'overwrite');
    expect(over.written).toEqual(['Inbox/a.md']);
    expect(readFileSync(nodePath.join(dirs.vaultDir, 'Inbox/a.md'), 'utf8')).toBe('mới');
  });

  it('BỎ QUA entry symlink — không tạo symlink nào trong vault', async () => {
    const zipPath = nodePath.join(workDir, 'link.zip');
    makeZip(zipPath, [
      { name: 'thoat', content: '/etc', symlink: true },
      { name: 'that.md', content: 'file thường' },
    ]);
    const res = await extractZip(zipPath, '', 'overwrite');
    expect(res.written).toEqual(['that.md']);
    expect(res.skipped).toEqual(['thoat (symlink)']);
    expect(readdirSync(dirs.vaultDir).sort()).toEqual(['that.md']);
  });

  it('dừng khi vượt ngưỡng số entry (chống zip bomb)', async () => {
    const zipPath = nodePath.join(workDir, 'bomb.zip');
    const many: RawEntry[] = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i++) many.push({ name: `f${i}.md`, content: 'x' });
    makeZip(zipPath, many);
    await expect(extractZip(zipPath, '', 'overwrite')).rejects.toThrow(/vượt giới hạn/);
  });

  it('giải nén nhiều file một lượt và bỏ qua entry thư mục', async () => {
    const zipPath = nodePath.join(workDir, 'multi.zip');
    makeZip(zipPath, [
      { name: 'x/1.md', content: 'một' },
      { name: 'x/2.md', content: 'hai' },
      { name: 'y/3.md', content: 'ba' },
    ]);
    const res = await extractZip(zipPath, '', 'rename');
    expect(res.written.sort()).toEqual(['x/1.md', 'x/2.md', 'y/3.md']);
    expect(res.errors).toEqual([]);
  });
});
