/**
 * Capstone e2e cho MCP-in-web-app: dựng server THẬT (vault + data dir tạm), seed
 * key MCP in-process, rồi dùng MCP CLIENT THẬT (@modelcontextprotocol/sdk) nối
 * /mcp?key= qua Streamable HTTP và chạy vòng đọc/ghi/sửa/xóa trên note tạm.
 * Chạy: cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const PORT = 18899;
const BASE = `http://127.0.0.1:${PORT}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
const textOf = (r: any): string =>
  Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? '').join('\n') : '';

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function connect(key: string): Promise<Client> {
  const client = new Client({ name: 'verify-mcp', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp?key=${key}`));
  await client.connect(transport);
  return client;
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wo-mcp-data-'));
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'wo-mcp-vault-'));
  process.env.DATA_DIR = dataDir;
  process.env.VAULT_PATH = vaultDir;

  // Seed an MCP key BEFORE the server boots (server loads settings.json at boot).
  const { createKey } = await import('../src/services/mcpkeys.js');
  const { raw: key } = await createKey('verify-mcp');

  let child: ChildProcess | null = null;
  try {
    child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
      cwd: serverDir,
      env: { ...process.env, DATA_DIR: dataDir, VAULT_PATH: vaultDir, PORT: String(PORT), HOST: '127.0.0.1', WEBOBSIDIAN_WATCH: 'polling' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server] ${d}`));

    check('server khởi động (healthz)', await waitForHealth(30_000));

    // --- bad key rejected ---
    let rejected = false;
    try { await connect('mcp_wrong'); } catch { rejected = true; }
    check('key sai → connect bị từ chối (401)', rejected);

    // --- good key: tool cycle ---
    const client = await connect(key);
    const tools = await client.listTools();
    check('listTools trả 11 tool', tools.tools.length === 11, tools.tools.map((t) => t.name));

    const h = await client.callTool({ name: 'health_check', arguments: {} });
    check('health_check ok', textOf(h).includes('webobsidian-agent-api'), textOf(h));

    const notePath = 'MCP/Verify Note.md';
    const w = await client.callTool({ name: 'write_note', arguments: { path: notePath, content: 'xin chào thế giới\nhàng hai', base_version: '' } });
    check('write_note tạo mới', textOf(w).includes('Đã ghi'), textOf(w));

    const r = await client.callTool({ name: 'read_note', arguments: { path: notePath } });
    check('read_note thấy nội dung + version', textOf(r).includes('xin chào thế giới') && textOf(r).includes('version:'), textOf(r));

    const g = await client.callTool({ name: 'grep_note', arguments: { path: notePath, query: 'hàng' } });
    check('grep_note tìm thấy khớp', textOf(g).includes('khớp trong'), textOf(g));

    const e = await client.callTool({ name: 'edit_note', arguments: { path: notePath, old_string: 'hàng hai', new_string: 'dòng 2' } });
    check('edit_note thay 1 chỗ', textOf(e).includes('thay 1 chỗ'), textOf(e));

    const a = await client.callTool({ name: 'append_note', arguments: { path: notePath, text: '\nphần thêm' } });
    check('append_note ok', textOf(a).includes('Đã thêm'), textOf(a));

    const l = await client.callTool({ name: 'list_notes', arguments: { folder: 'MCP' } });
    check('list_notes thấy note trong folder', textOf(l).includes('Verify Note.md'), textOf(l));

    // sort/order được nhận và echo lại; mặc định modified/desc
    const lDefault = await client.callTool({ name: 'list_notes', arguments: {} });
    check('list_notes mặc định = modified/desc', textOf(lDefault).includes('"sort": "modified"') && textOf(lDefault).includes('"order": "desc"'), textOf(lDefault));
    const lName = await client.callTool({ name: 'list_notes', arguments: { sort: 'name', order: 'asc' } });
    check('list_notes nhận sort=name/order=asc', textOf(lName).includes('"sort": "name"') && textOf(lName).includes('"order": "asc"'), textOf(lName));

    const b = await client.callTool({ name: 'get_backlinks', arguments: { path: notePath } });
    check('get_backlinks trả (mảng, rỗng cũng ok)', textOf(b).includes('backlinks'), textOf(b));

    const t = await client.callTool({ name: 'list_tags', arguments: {} });
    check('list_tags trả tags', textOf(t).includes('tags'), textOf(t));

    // search index cập nhật bất đồng bộ sau ghi
    await new Promise((r2) => setTimeout(r2, 600));
    const s = await client.callTool({ name: 'search_notes', arguments: { query: 'chào' } });
    check('search_notes thấy note sau ghi', textOf(s).includes('Verify Note.md'), textOf(s));

    const d = await client.callTool({ name: 'delete_note', arguments: { path: notePath } });
    check('delete_note vào trash', textOf(d).includes('Đã xóa'), textOf(d));

    const r2 = await client.callTool({ name: 'read_note', arguments: { path: notePath } });
    check('read_note sau xóa → lỗi Not found (isError)', (r2 as any).isError === true && textOf(r2).includes('Not found'), r2);

    await client.close();
  } finally {
    child?.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 500));
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    check('dọn temp dirs', !existsSync(dataDir) && !existsSync(vaultDir));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
