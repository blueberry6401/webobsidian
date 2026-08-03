/**
 * Capstone e2e cho MCP-in-web-app: dựng server THẬT (vault + data dir tạm), seed
 * key MCP, rồi dùng MCP CLIENT THẬT (@modelcontextprotocol/sdk) nối /mcp?key=
 * qua Streamable HTTP và chạy vòng đọc/ghi/sửa/xóa trên note tạm.
 *
 * Từ Phase 36 script dựng HAI server (hai vault độc lập) để kiểm chứng luồng
 * chuyển file vault A → vault B bằng download_files + upload_from_url.
 * Chạy: cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts
 */
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.resolve(__dirname, '..');
const PORT_A = 18899;
const PORT_B = 18898;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}
const textOf = (r: any): string =>
  Array.isArray(r?.content) ? r.content.map((c: any) => c?.text ?? '').join('\n') : '';

async function waitForHealth(base: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${base}/healthz`)).ok) return true; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

async function connect(base: string, key: string): Promise<Client> {
  const client = new Client({ name: 'verify-mcp', version: '0.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp?key=${key}`));
  await client.connect(transport);
  return client;
}

/**
 * Seed key MCP trong một process PHỤ: `config.dataDir` được chốt lúc nạp module,
 * nên process này không thể tạo key cho hai DATA_DIR khác nhau.
 */
function seedKey(dataDir: string, vaultDir: string): string {
  const code = `
    const { createKey } = await import('./src/services/mcpkeys.js');
    const { raw } = await createKey('verify-mcp');
    process.stdout.write(raw);
  `;
  return execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: serverDir,
    env: { ...process.env, DATA_DIR: dataDir, VAULT_PATH: vaultDir },
  }).toString().trim();
}

function startServer(o: { port: number; dataDir: string; vaultDir: string }): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: serverDir,
    env: {
      ...process.env,
      DATA_DIR: o.dataDir,
      VAULT_PATH: o.vaultDir,
      PORT: String(o.port),
      HOST: '127.0.0.1',
      WEBOBSIDIAN_WATCH: 'polling',
      // Cả hai server chạy trên 127.0.0.1 nên guard SSRF sẽ chặn upload_from_url.
      // Chỉ mở loopback trong e2e — TUYỆT ĐỐI không bật trên production.
      WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(`[server:${o.port}] ${d}`));
  return child;
}

async function main() {
  const dataA = mkdtempSync(path.join(tmpdir(), 'wo-mcp-data-'));
  const vaultA = mkdtempSync(path.join(tmpdir(), 'wo-mcp-vault-'));
  const dataB = mkdtempSync(path.join(tmpdir(), 'wo-mcp-datab-'));
  const vaultB = mkdtempSync(path.join(tmpdir(), 'wo-mcp-vaultb-'));

  const keyA = seedKey(dataA, vaultA);
  const keyB = seedKey(dataB, vaultB);

  let childA: ChildProcess | null = null;
  let childB: ChildProcess | null = null;
  try {
    childA = startServer({ port: PORT_A, dataDir: dataA, vaultDir: vaultA });
    childB = startServer({ port: PORT_B, dataDir: dataB, vaultDir: vaultB });

    check('server A khởi động (healthz)', await waitForHealth(BASE_A, 30_000));
    check('server B khởi động (healthz)', await waitForHealth(BASE_B, 30_000));

    // --- bad key rejected ---
    let rejected = false;
    try { await connect(BASE_A, 'mcp_wrong'); } catch { rejected = true; }
    check('key sai → connect bị từ chối (401)', rejected);

    // --- good key: tool cycle ---
    const client = await connect(BASE_A, keyA);
    const tools = await client.listTools();
    check('listTools trả 15 tool', tools.tools.length === 15, tools.tools.map((t) => t.name));

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

    // ================= Phase 36: chuyển file vault A → vault B =================
    // Seed vault A: một note có dấu + một file NHỊ PHÂN (đường mà 11 tool cũ
    // không đụng tới được).
    const binRel = 'Ảnh/mẫu.bin';
    const binBytes = Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x42, 0x00, 0x7f]);
    await fsp.mkdir(path.join(vaultA, 'Ảnh'), { recursive: true });
    await fsp.writeFile(path.join(vaultA, binRel), binBytes);
    const mdRel = 'Chuyển/Ghi chú có dấu.md';
    await client.callTool({ name: 'write_note', arguments: { path: mdRel, content: 'nội dung tiếng Việt', base_version: '' } });

    // Hồi quy cho lỗ hổng đã khiến bản fa75f21 bị GỠ khỏi prod (2026-07-31):
    // đường dẫn tường minh không đi qua bộ lọc dotfile nên tải được .trash và
    // data.json của plugin trong .obsidian (chứa token).
    await fsp.mkdir(path.join(vaultA, '.obsidian', 'plugins', 'x'), { recursive: true });
    await fsp.writeFile(path.join(vaultA, '.obsidian/plugins/x/data.json'), '{"token":"BI-MAT"}');
    const leak = await client.callTool({
      name: 'download_files',
      arguments: { paths: ['.obsidian/plugins/x/data.json'] },
    });
    check('download_files TỪ CHỐI đường dẫn tường minh vào .obsidian', (leak as any).isError === true && textOf(leak).includes('file ẩn'), textOf(leak));
    const leak2 = await client.callTool({ name: 'download_files', arguments: { paths: ['.trash/x.md'] } });
    check('download_files TỪ CHỐI đường dẫn tường minh vào .trash', (leak2 as any).isError === true, textOf(leak2));

    const dl = await client.callTool({ name: 'download_files', arguments: {} });
    const dlJson = JSON.parse(textOf(dl));
    check('download_files trả link + đếm đủ file', typeof dlJson.url === 'string' && dlJson.fileCount >= 2, dlJson);

    // Link tải dùng được bằng HTTP thuần, KHÔNG auth, và KHÔNG bị SPA nuốt.
    const zipRes = await fetch(dlJson.url);
    const ctype = zipRes.headers.get('content-type') ?? '';
    check('link tải trả 200 + application/zip (không phải HTML của SPA)', zipRes.ok && ctype.includes('zip'), `${zipRes.status} ${ctype}`);
    const zipBuf = Buffer.from(await zipRes.arrayBuffer());
    check('nội dung tải về đúng là zip (magic PK\\x03\\x04)', zipBuf.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])), [...zipBuf.subarray(0, 4)]);

    const clientB = await connect(BASE_B, keyB);
    const up = await clientB.callTool({ name: 'upload_from_url', arguments: { url: dlJson.url } });
    const upJson = JSON.parse(textOf(up));
    check('upload_from_url ghi file sang vault B', Array.isArray(upJson.written) && upJson.written.length >= 2, upJson);
    check('upload_from_url không có entry lỗi', upJson.errors?.length === 0, upJson.errors);

    // So khớp BYTE từng file — đây là điều kiện đủ để tin luồng A→B.
    const gotBin = await fsp.readFile(path.join(vaultB, binRel));
    check('file nhị phân khớp từng byte sau khi chuyển', gotBin.equals(binBytes), { got: [...gotBin], want: [...binBytes] });
    const gotMd = await fsp.readFile(path.join(vaultB, mdRel), 'utf8');
    check('file tên có dấu khớp nội dung', gotMd === 'nội dung tiếng Việt', gotMd);
    // .obsidian của A KHÔNG được lọt sang B qua đường đóng gói cả vault
    check('zip cả vault KHÔNG chứa .obsidian', !existsSync(path.join(vaultB, '.obsidian')), 'rò .obsidian sang vault B');

    // rename: chuyển lần hai không được ghi đè bản đã có
    const up2 = await clientB.callTool({ name: 'upload_from_url', arguments: { url: dlJson.url } });
    const up2Json = JSON.parse(textOf(up2));
    check('chuyển lần hai → rename, không ghi đè', up2Json.written.some((p: string) => p.includes('(1)')), up2Json.written);

    // guard SSRF vẫn chặn link-local dù loopback đang được mở cho e2e
    const ssrf = await clientB.callTool({ name: 'upload_from_url', arguments: { url: 'http://169.254.169.254/latest/meta-data/' } });
    check('upload_from_url chặn IP metadata cloud', (ssrf as any).isError === true && textOf(ssrf).includes('bị chặn'), textOf(ssrf));

    // ---- đường kéo-thả: upload_files + transfer_status ----
    const uf = await clientB.callTool({ name: 'upload_files', arguments: { dest_folder: 'Kéo thả' } });
    const ufJson = JSON.parse(textOf(uf));
    check('upload_files trả url + ticket', typeof ufJson.url === 'string' && typeof ufJson.ticket === 'string', ufJson);

    const pageRes = await fetch(ufJson.url);
    const pageHtml = await pageRes.text();
    check('trang kéo-thả render đúng (không bị SPA catch-all nuốt)', pageRes.ok && pageHtml.includes('Kéo file'), pageHtml.slice(0, 160));

    const pending = await clientB.callTool({ name: 'transfer_status', arguments: { ticket: ufJson.ticket } });
    check('transfer_status trước khi tải = pending', textOf(pending).includes('"pending"'), textOf(pending));

    const fd = new FormData();
    fd.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'a.zip');
    const postRes = await fetch(ufJson.url, { method: 'POST', body: fd });
    const postJson: any = await postRes.json();
    check('POST zip lên ticket ghi được file', postRes.ok && postJson.written.length >= 2, postJson);
    check('file đẩy tay nằm đúng dest_folder', postJson.written.every((p: string) => p.startsWith('Kéo thả/')), postJson.written);

    const st = await clientB.callTool({ name: 'transfer_status', arguments: { ticket: ufJson.ticket } });
    check('transfer_status sau khi tải = done', textOf(st).includes('"done"'), textOf(st));

    const fd2 = new FormData();
    fd2.append('file', new Blob([new Uint8Array(zipBuf)], { type: 'application/zip' }), 'a.zip');
    const twice = await fetch(ufJson.url, { method: 'POST', body: fd2 });
    check('ticket đẩy chỉ dùng được một lần (lần 2 → 404)', twice.status === 404, twice.status);

    const bogus = await fetch(`${BASE_B}/transfer/d/khongcothat`);
    check('token tải bịa → 404 (không phải HTML của SPA)', bogus.status === 404, bogus.status);

    // Chứng minh SPA catch-all ĐANG bật — nếu không, ba check "không bị SPA
    // nuốt" ở trên xanh một cách vô nghĩa (chạy trước khi build thì server
    // không mount static/catch-all và mọi đường dẫn lạ đều 404 sẵn).
    const spa = await fetch(`${BASE_B}/mot-duong-dan-bat-ky`);
    const spaBody = await spa.text();
    check(
      'SPA catch-all đang bật (điều kiện để các check /transfer ở trên có nghĩa)',
      spa.ok && spaBody.includes('<!doctype html'),
      `${spa.status} ${spaBody.slice(0, 80)} — nếu FAIL: chạy npm run build rồi thử lại`,
    );

    // note vừa chuyển sang B phải vào được index tìm kiếm của B
    await new Promise((r3) => setTimeout(r3, 800));
    const sB = await clientB.callTool({ name: 'search_notes', arguments: { query: 'tiếng Việt' } });
    check('search index của B thấy note vừa chuyển', textOf(sB).includes('Ghi chú có dấu'), textOf(sB));

    await client.close();
    await clientB.close();
  } finally {
    for (const c of [childA, childB]) {
      c?.kill('SIGTERM');
    }
    await new Promise((r) => setTimeout(r, 500));
    for (const c of [childA, childB]) {
      if (c && c.exitCode === null) c.kill('SIGKILL');
    }
    for (const dir of [dataA, vaultA, dataB, vaultB]) {
      rmSync(dir, { recursive: true, force: true });
    }
    check('dọn temp dirs', ![dataA, vaultA, dataB, vaultB].some((d) => existsSync(d)));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
