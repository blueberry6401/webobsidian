/**
 * Script kiểm chứng nhanh cho tính năng PATCH /api/v1/notes/{path} find/replace nguyên tử
 * (PRD 1.8, FR-6 / M7.6). Repo không có test framework (vitest/jest) nên dùng script này,
 * chạy bằng tsx:
 *
 *   cd server && ../node_modules/.bin/tsx scripts/verify-agent-edit.ts
 *
 * Phần 1 — unit test hàm thuần `applyEdit` (services/noteedit.ts).
 * Phần 2 — e2e: dựng server THẬT với vault + data dir tạm, seed API key, gọi HTTP thật
 *          qua fetch và kiểm tra cả response lẫn nội dung file trên đĩa.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ok    ${name}`);
  } else {
    failed++;
    console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : '');
  }
}
function eq(name: string, actual: unknown, expected: unknown) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), { actual, expected });
}

// ---------------------------------------------------------------------------
// Phần 1 — unit: applyEdit
// ---------------------------------------------------------------------------
async function unitTests() {
  console.log('\n[unit] applyEdit (services/noteedit.ts)');
  const { applyEdit } = await import('../src/services/noteedit.js');

  eq('thay đúng 1 lần khi find duy nhất', applyEdit('a b c', 'b', 'X', false), {
    content: 'a X c',
    replaced: 1,
  });
  eq('0 khớp → find_not_found', applyEdit('a b c', 'z', 'X', false), { error: 'find_not_found' });
  eq('2 khớp, không replaceAll → find_ambiguous + count', applyEdit('x.x', 'x', 'y', false), {
    error: 'find_ambiguous',
    count: 2,
  });
  eq('replaceAll thay tất cả + đếm đúng', applyEdit('x.x.x', 'x', 'y', true), {
    content: 'y.y.y',
    replaced: 3,
  });
  eq('replaceAll với 1 khớp vẫn hợp lệ', applyEdit('a b c', 'b', 'X', true), {
    content: 'a X c',
    replaced: 1,
  });
  eq(
    'không replaceAll chỉ thay lần ĐẦU TIÊN (khi duy nhất)',
    applyEdit('start mid end', 'mid', 'M', false),
    { content: 'start M end', replaced: 1 },
  );
  eq('replace rỗng = xoá đoạn', applyEdit('keep DELETE keep', ' DELETE', '', false), {
    content: 'keep keep',
    replaced: 1,
  });
  // Bẫy regex/$: find và replace phải là literal thuần
  eq('find chứa ký tự regex đặc biệt vẫn literal', applyEdit('a.*b', '.*', 'X', false), {
    content: 'aXb',
    replaced: 1,
  });
  eq('replace chứa $& giữ nguyên literal', applyEdit('giá: price', 'price', '$&100', false), {
    content: 'giá: $&100',
    replaced: 1,
  });
  eq('replace chứa $1/$$ giữ nguyên literal (replaceAll)', applyEdit('a-a', 'a', '$1$$', true), {
    content: '$1$$-$1$$',
    replaced: 2,
  });
  // Đếm không chồng lấn (cùng ngữ nghĩa String.replaceAll): 'aa' xuất hiện 1 lần trong 'aaa'
  eq('khớp chồng lấn: đếm không chồng lấn như replaceAll', applyEdit('aaa', 'aa', 'b', false), {
    content: 'ba',
    replaced: 1,
  });
  eq('unicode/tiếng Việt', applyEdit('xin chào thế giới', 'chào', 'chào bạn', false), {
    content: 'xin chào bạn thế giới',
    replaced: 1,
  });
}

// ---------------------------------------------------------------------------
// Phần 2 — e2e: server thật + HTTP thật
// ---------------------------------------------------------------------------
const PORT = 18877;
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

async function e2eTests() {
  console.log('\n[e2e] server thật với vault tạm');
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wo-edit-data-'));
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'wo-edit-vault-'));
  process.env.DATA_DIR = dataDir;
  process.env.VAULT_PATH = vaultDir;

  // Seed API key trực tiếp vào settings.json của data dir tạm (env đặt TRƯỚC khi import
  // config — config.ts đọc env lúc import).
  const { createKey } = await import('../src/services/apikeys.js');
  const { raw: apiKey } = await createKey('verify-agent-edit', ['read', 'write', 'search']);

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
    check('server khởi động (healthz)', healthy);
    if (!healthy) return; // finally vẫn dọn dẹp

    const notePath = '/api/v1/notes/Agent/Edit Test.md';
    const noteAbs = path.join(vaultDir, 'Agent', 'Edit Test.md');

    // --- Hành vi append cũ phải giữ nguyên 100% ---
    let r = await req('PATCH', notePath, apiKey, { append: 'dòng một' });
    check('append cũ: tạo note mới khi chưa tồn tại', r.status === 200, r);
    r = await req('PATCH', notePath, apiKey, { append: 'dòng hai' });
    check('append cũ: nối tiếp có newline', r.status === 200, r);
    eq('append cũ: nội dung file đúng', readFileSync(noteAbs, 'utf8'), 'dòng một\ndòng hai');
    r = await req('PATCH', notePath, apiKey, {});
    check('append cũ: body {} → append chuỗi rỗng, 200', r.status === 200, r);
    // Hành vi cũ giữ nguyên: append '' vào file chưa kết thúc bằng \n sẽ thêm '\n' nối
    eq('append cũ: body {} thêm newline kết thúc (hành vi cũ)', readFileSync(noteAbs, 'utf8'), 'dòng một\ndòng hai\n');
    r = await req('PATCH', notePath, apiKey, { append: 123 });
    check('append cũ: append sai kiểu → vẫn coi như rỗng (hành vi cũ)', r.status === 200, r);
    eq('append cũ: file không đổi sau append rỗng lần 2', readFileSync(noteAbs, 'utf8'), 'dòng một\ndòng hai\n');

    // --- Validate nhánh edit ---
    r = await req('PATCH', notePath, apiKey, { find: 'a', replace: 'b', append: 'c' });
    check('cả find lẫn append → 400 invalid_body', r.status === 400, r);
    eq('  body lỗi đúng shape', r.json, { error: 'invalid_body' });
    r = await req('PATCH', notePath, apiKey, { find: '', replace: 'b' });
    check('find rỗng → 400 invalid_body', r.status === 400, r);
    r = await req('PATCH', notePath, apiKey, { find: 'a' });
    check('thiếu replace → 400 invalid_body', r.status === 400, r);
    r = await req('PATCH', notePath, apiKey, { find: 'a', replace: 5 });
    check('replace sai kiểu → 400 invalid_body', r.status === 400, r);
    r = await req('PATCH', notePath, apiKey, { find: 42, replace: 'b' });
    check('find sai kiểu → 400 invalid_body', r.status === 400, r);
    r = await req('PATCH', '/api/v1/notes/KhongTonTai/x.md', apiKey, { find: 'a', replace: 'b' });
    check('note không tồn tại → 404', r.status === 404, r);
    eq('  body 404 đúng shape', r.json, { error: 'Not found' });

    // --- Nhánh edit ---
    r = await req('PATCH', notePath, apiKey, { find: 'không có trong note', replace: 'x' });
    check('0 khớp → 409 find_not_found', r.status === 409, r);
    eq('  body đúng shape', r.json, { error: 'find_not_found' });
    r = await req('PATCH', notePath, apiKey, { find: 'dòng', replace: 'hàng' });
    check('2 khớp không replaceAll → 409 find_ambiguous', r.status === 409, r);
    eq('  body kèm count', r.json, { error: 'find_ambiguous', count: 2 });
    r = await req('PATCH', notePath, apiKey, { find: 'dòng', replace: 'hàng', replaceAll: 'yes' });
    check('replaceAll không phải true (truthy khác) vẫn 409', r.status === 409, r);
    r = await req('PATCH', notePath, apiKey, { find: 'dòng một', replace: 'dòng 1' });
    check('1 khớp → 200', r.status === 200, r);
    eq('  response {ok, path, replaced}', r.json, { ok: true, path: 'Agent/Edit Test.md', replaced: 1 });
    eq('  file trên đĩa đã thay', readFileSync(noteAbs, 'utf8'), 'dòng 1\ndòng hai\n');
    r = await req('PATCH', notePath, apiKey, { find: 'dòng', replace: 'giá $& là $1', replaceAll: true });
    check('replaceAll:true → 200', r.status === 200, r);
    eq('  replaced = 2', (r.json as { replaced?: number })?.replaced, 2);
    eq('  $&/$1 giữ literal trên đĩa', readFileSync(noteAbs, 'utf8'), 'giá $& là $1 1\ngiá $& là $1 hai\n');

    // --- Search index được cập nhật sau edit (reindex) ---
    await new Promise((r2) => setTimeout(r2, 500));
    r = await req('GET', '/api/v1/search?q=hai', apiKey);
    const hits = (r.json as { hits?: { path: string }[] })?.hits ?? [];
    check('search thấy nội dung sau edit (reindex chạy)', hits.some((h) => h.path === 'Agent/Edit Test.md'), r);

    // --- Auth vẫn được enforce trên nhánh mới ---
    r = await req('PATCH', notePath, 'sai-key', { find: 'a', replace: 'b' });
    check('key sai → 401', r.status === 401, r);
  } finally {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    check('dọn temp dirs', !existsSync(dataDir) && !existsSync(vaultDir));
  }
}

await unitTests();
await e2eTests();
console.log(`\nKết quả: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
