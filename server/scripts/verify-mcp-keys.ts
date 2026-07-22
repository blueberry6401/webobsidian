/**
 * Kiểm chứng kho key MCP (services/mcpkeys.ts) — in-process, không HTTP.
 * Chạy: cd server && ../node_modules/.bin/tsx scripts/verify-mcp-keys.ts
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) { passed++; console.log(`  ok    ${name}`); }
  else { failed++; console.error(`  FAIL  ${name}`, detail !== undefined ? JSON.stringify(detail) : ''); }
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'wo-mcpkeys-'));
  const vaultDir = mkdtempSync(path.join(tmpdir(), 'wo-mcpkeys-vault-'));
  process.env.DATA_DIR = dataDir;
  process.env.VAULT_PATH = vaultDir;
  try {
    const mcpkeys = await import('../src/services/mcpkeys.js');

    const { raw, record } = await mcpkeys.createKey('Claude – Test');
    check('createKey trả raw dạng mcp_', raw.startsWith('mcp_'), raw.slice(0, 4));
    check('record không lộ hash', !('hash' in record));
    check('prefix khớp', raw.startsWith(record.prefix));

    const list1 = await mcpkeys.listKeys();
    check('listKeys có 1 key', list1.length === 1, list1);
    check('listKeys không lộ hash', list1.every((k) => !('hash' in k)));

    const authed = await mcpkeys.authenticateKey(raw);
    check('authenticateKey đúng raw → record', authed?.id === record.id, authed);
    check('authenticateKey sai raw → null', (await mcpkeys.authenticateKey('mcp_wrong')) === null);
    check('authenticateKey rỗng → null', (await mcpkeys.authenticateKey('')) === null);

    const revoked = await mcpkeys.revokeKey(record.id);
    check('revokeKey lần đầu → true', revoked === true);
    check('revokeKey lần hai → false (đã thu hồi)', (await mcpkeys.revokeKey(record.id)) === false);
    check('authenticateKey sau thu hồi → null', (await mcpkeys.authenticateKey(raw)) === null);

    const list2 = await mcpkeys.listKeys();
    check('key thu hồi vẫn hiện trong list (soft-revoke)', list2.length === 1 && list2[0].revoked === true, list2);
    check('revokeKey id lạ → false', (await mcpkeys.revokeKey('nope')) === false);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(vaultDir, { recursive: true, force: true });
    check('dọn temp dirs', !existsSync(dataDir) && !existsSync(vaultDir));
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
