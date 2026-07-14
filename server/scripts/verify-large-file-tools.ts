/**
 * Kiểm chứng tool file lớn Agent API: read phân đoạn+version, /note-matches, list folder,
 * PUT kiểm base_version. Repo không có test framework — chạy:
 *   cd server && ../node_modules/.bin/tsx scripts/verify-large-file-tools.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { contentVersion } from '../src/services/noteversion.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
let passed = 0,
  failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}
function eq(name: string, a: unknown, b: unknown) {
  check(name, JSON.stringify(a) === JSON.stringify(b), { a, b });
}

const PORT = 18878;
const BASE = `http://127.0.0.1:${PORT}`;
async function req(method: string, urlPath: string, apiKey: string, body?: unknown) {
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json: unknown = await res.json().catch(() => null);
  return { status: res.status, json };
}
async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/healthz`);
      if (r.ok) return true;
    } catch {
      /* chưa lên */
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function unitTests() {
  console.log('\n[unit] contentVersion');
  check('tất định: cùng nội dung cùng version', contentVersion('abc') === contentVersion('abc'));
  check('khác nội dung khác version', contentVersion('abc') !== contentVersion('abd'));
  check('dài 16 hex', /^[0-9a-f]{16}$/.test(contentVersion('hello')));
}

async function e2eTests() {
  console.log('\n[e2e] server thật với vault tạm');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wo-lft-data-'));
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'wo-lft-vault-'));
  process.env.DATA_DIR = dataDir;
  process.env.VAULT_PATH = vaultDir;
  const { createKey } = await import('../src/services/apikeys.js');
  const { raw: apiKey } = await createKey('verify-lft', ['read', 'write', 'search']);

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        VAULT_PATH: vaultDir,
        PORT: String(PORT),
        HOST: '127.0.0.1',
        WEBOBSIDIAN_WATCH: 'polling',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));
    const healthy = await waitForHealth(30_000);
    check('server khởi động', healthy);
    if (!healthy) return;

    // Seed note nhiều dòng
    const big = Array.from({ length: 30 }, (_, i) => `dòng ${i + 1}`).join('\n');
    let r = await req('PUT', '/api/v1/notes/Folder A/Big.md', apiKey, { content: big, base_version: '' });
    check('tạo note mới base_version="" → 200', r.status === 200, r);
    const v1 = (r.json as { version?: string })?.version;
    check('trả version', typeof v1 === 'string' && v1.length === 16, r);

    // read phân đoạn
    r = await req('GET', '/api/v1/notes/Folder%20A/Big.md?offset=5&limit=3', apiKey);
    const rd = r.json as { content: string; totalLines: number; hasMore: boolean; version: string };
    eq('read offset=5 limit=3 content đúng', rd.content, 'dòng 6\ndòng 7\ndòng 8');
    eq('totalLines=30', rd.totalLines, 30);
    check('hasMore=true', rd.hasMore === true, rd);
    eq('version khớp contentVersion(big)', rd.version, contentVersion(big));

    // /note-matches
    r = await req(
      'GET',
      '/api/v1/note-matches?path=' + encodeURIComponent('Folder A/Big.md') + '&q=' + encodeURIComponent('dòng 12'),
      apiKey,
    );
    const mm = r.json as { count: number; matches: { line: number; text: string }[] };
    check('note-matches tìm thấy', mm.count >= 1, r);
    eq('số dòng của "dòng 12" = 12', mm.matches[0]?.line, 12);
    r = await req('GET', '/api/v1/note-matches?path=' + encodeURIComponent('Folder A/Big.md'), apiKey);
    check('thiếu q → 400', r.status === 400, r);
    r = await req('GET', '/api/v1/note-matches?path=KhongCo.md&q=x', apiKey);
    check('note không tồn tại → 404', r.status === 404, r);

    // note có frontmatter: số dòng phải tính theo TOÀN file (gồm frontmatter), khớp read_note
    const fm = '---\ntitle: Ghi chú\ntags: [x, y]\n---\n# Tiêu đề\nnội dung mốc ở đây';
    // "nội dung mốc" nằm ở dòng 6 của file (4 dòng frontmatter + 1 dòng tiêu đề + chính nó)
    await req('PUT', '/api/v1/notes/FM.md', apiKey, { content: fm, base_version: '' });
    r = await req('GET', '/api/v1/note-matches?path=FM.md&q=' + encodeURIComponent('nội dung mốc'), apiKey);
    const fmm = r.json as { matches: { line: number }[] };
    eq('số dòng tính theo toàn file (gồm frontmatter) = 6', fmm.matches[0]?.line, 6);
    // Xác nhận bắc cầu: read_note offset=5 (0-based → dòng 6) trả đúng dòng đó
    r = await req('GET', '/api/v1/notes/FM.md?offset=5&limit=1', apiKey);
    eq('read_note offset=5 trỏ đúng dòng grep chỉ', (r.json as { content: string }).content, 'nội dung mốc ở đây');

    // list folder
    await req('PUT', '/api/v1/notes/Folder B/Other.md', apiKey, { content: 'x', base_version: '' });
    r = await req('GET', '/api/v1/notes?folder=Folder%20A', apiKey);
    const ls = r.json as { total: number; notes: string[] };
    check(
      'list folder chỉ note trong Folder A',
      ls.notes.every((p) => p.startsWith('Folder A/')) && ls.notes.includes('Folder A/Big.md'),
      r,
    );
    check('total phản ánh tập đã lọc', ls.total === ls.notes.length, r);

    // write conflict
    r = await req('PUT', '/api/v1/notes/Folder A/Big.md', apiKey, { content: 'ghi đè', base_version: 'saihash0000000000' });
    check('base_version sai → 409 version_conflict', r.status === 409, r);
    eq('kèm currentVersion đúng', (r.json as { currentVersion?: string })?.currentVersion, contentVersion(big));
    r = await req('PUT', '/api/v1/notes/Folder A/Big.md', apiKey, { content: 'ghi đè' });
    check('thiếu base_version → 400', r.status === 400, r);
    r = await req('PUT', '/api/v1/notes/Moi.md', apiKey, { content: 'x', base_version: 'khong-rong' });
    check('tạo mới nhưng base_version != "" → 409', r.status === 409, r);
    r = await req('PUT', '/api/v1/notes/Folder A/Big.md', apiKey, { content: 'nội dung mới', base_version: v1 });
    check('base_version đúng → 200 ghi đè', r.status === 200, r);
    eq('version mới = contentVersion("nội dung mới")', (r.json as { version?: string })?.version, contentVersion('nội dung mới'));
  } finally {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    check('dọn temp dirs', !existsSync(dataDir) && !existsSync(vaultDir));
  }
}

unitTests();
await e2eTests();
console.log(`\nKết quả: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
