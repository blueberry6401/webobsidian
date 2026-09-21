import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config.ts đọc env lúc import → phải set trước rồi mới dynamic-import engine.
let tmp: string;
let qmd: typeof import('./search.js')['qmd'];

const NOTES: Record<string, string> = {
  'a.md': 'Say hello world to everyone #greeting',
  'b.md': 'hello there, what a world',
  'c.md': 'nothing relevant here',
  'Hello World Note.md': 'body without the words',
  'e.md': 'HELLO WORLD in caps',
  'f.md': 'foo -- bar',
  // đối chứng: khớp từ rời / tag nhưng KHÔNG có cụm liền → phải bị loại khi AND với cụm
  'g.md': 'caps lock but hello, world',
  'h.md': 'greeting only #greeting',
};

const paths = (hits: { path: string }[]) => hits.map((h) => h.path).sort();

beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wo-search-'));
  const vault = path.join(tmp, 'vault');
  await fs.mkdir(vault);
  for (const [name, body] of Object.entries(NOTES)) await fs.writeFile(path.join(vault, name), body);
  process.env.VAULT_PATH = vault;
  process.env.DATA_DIR = path.join(tmp, 'data');
  ({ qmd } = await import('./search.js'));
  await qmd.build();
});

afterAll(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('qmd.search — cụm nguyên văn', () => {
  it('không có nháy: giữ hành vi cũ (từng từ, OR) → note có từ rời vẫn hiện', async () => {
    const hits = await qmd.search('hello world');
    expect(paths(hits)).toContain('b.md');
    expect(paths(hits)).toContain('a.md');
  });

  it('"hello world": chỉ note có cụm liền nhau (body hoặc title), không phân biệt hoa/thường', async () => {
    const hits = await qmd.search('"hello world"');
    expect(paths(hits)).toEqual(['Hello World Note.md', 'a.md', 'e.md']);
  });

  it('cụm + từ rời = AND', async () => {
    expect(paths(await qmd.search('"hello world" caps'))).toEqual(['e.md']);
  });

  it('cụm + qualifier tag: = AND', async () => {
    expect(paths(await qmd.search('"hello world" tag:greeting'))).toEqual(['a.md']);
  });

  it('hai cụm = AND', async () => {
    expect(paths(await qmd.search('"hello world" "in caps"'))).toEqual(['e.md']);
    expect(paths(await qmd.search('"hello world" "no such"'))).toEqual([]);
  });

  it('cụm toàn ký tự không tạo token index (vd "--") vẫn tìm được bằng quét toàn vault', async () => {
    expect(paths(await qmd.search('"--"'))).toEqual(['f.md']);
  });

  it('limit vẫn áp dụng cho kết quả cụm', async () => {
    expect((await qmd.search('"hello world"', 2)).length).toBe(2);
  });
});
