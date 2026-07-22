# MCP-in-web-app Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Host the MCP server directly inside the WebObsidian web app (Express) with its own key store, so the Cloudflare Worker can be retired.

**Architecture:** Add a `/mcp` Streamable-HTTP endpoint to the Express server that authenticates a `?key=` token against a new JSON-backed MCP key store, and serves 11 MCP tools that call the existing in-process vault/search/links services directly (no HTTP hop, no `wok_` intermediary). Key management gets its own "MCP" tab in Settings, mirroring the retired Worker `/admin` page.

**Tech Stack:** TypeScript, Express 4, `@modelcontextprotocol/sdk` v1.29 (`McpServer` + `StreamableHTTPServerTransport`, stateless), zod v3, React (Settings UI), `tsx` verify scripts.

## Global Constraints

- **No new DB engine.** All persistent state lives in `data/settings.json` via the existing `settings.ts` store (copied verbatim from repo CLAUDE.md). MCP keys are a new field in that file.
- **Hash secrets before storing; never log tokens.** Reuse `hashApiKey` (SHA-256) from `server/src/services/auth.ts`.
- **TypeScript, avoid `any`** in server code where practical (the existing key UI uses `any[]` for the key list — matching that local pattern is fine).
- **Path safety** is already enforced by `vault.resolveInVault`; all tools go through the `vault.*` service, so traversal guards are inherited.
- **Do not touch `/api/v1` (agentRouter) or the existing `wok_` API-key system** — they stay for other consumers.
- Test convention: server uses `vitest` for pure units and **`tsx` scripts under `server/scripts/` that spawn the real server + drive real clients** for integration (see `verify-agent-edit.ts`). The capstone MCP test is a `tsx` script driving a **real MCP client**.
- MCP tool names, descriptions (Vietnamese), input schemas, and `readOnlyHint`/`destructiveHint` annotations must match the retired Worker (`webobsidian-mcp/src/mcp.ts`) so Claude's behavior is unchanged. **11 tools:** `health_check`, `list_notes`, `read_note`, `search_notes`, `grep_note`, `list_tags`, `get_backlinks`, `write_note`, `append_note`, `edit_note`, `delete_note`.

---

## File Structure

- Create `server/src/services/mcpkeys.ts` — MCP key CRUD (create/list/revoke/authenticate), JSON-backed. One responsibility: MCP key lifecycle.
- Create `server/src/services/mcptools.ts` — `createMcpServer()` building the `McpServer` with 11 tools wired to in-process services.
- Create `server/src/routes/mcp.ts` — the `/mcp` Streamable-HTTP endpoint (key auth + per-request transport).
- Create `server/src/routes/mcpkeys.ts` — `/api/mcp-keys` CRUD REST (cookie-authed, for the Settings UI).
- Create `server/scripts/verify-mcp-keys.ts` — in-process unit test for the key store.
- Create `server/scripts/verify-mcp.ts` — capstone e2e: real server + real MCP client.
- Modify `server/src/services/settings.ts` — add `McpKeySchema`, `mcp.keys` field, `McpKeyRecord` type, redact.
- Modify `server/src/index.ts` — mount `/api/mcp-keys` and `/mcp`; add `/mcp` to SPA-fallback exclusion.
- Modify `server/package.json` — add `@modelcontextprotocol/sdk` dependency.
- Modify `web/src/lib/api.ts` — `listMcpKeys` / `createMcpKey` / `revokeMcpKey`.
- Modify `web/src/components/Settings.tsx` — add `'mcp'` section + `<McpKeys/>` component.
- Modify `docs`/`CHANGELOG.md`/`IMPLEMENTATION_PLAN.md` — record the feature (repo CLAUDE.md requires plan/PRD upkeep).

---

## Task 1: MCP key store (settings schema + service)

**Files:**
- Modify: `server/src/services/settings.ts`
- Create: `server/src/services/mcpkeys.ts`
- Create (test): `server/scripts/verify-mcp-keys.ts`

**Interfaces:**
- Produces: `McpKeyRecord = { id, name, hash, prefix, createdAt, lastUsed: string|null, revoked: boolean }` (exported from `settings.ts`).
- Produces: `mcpkeys.listKeys()`, `mcpkeys.createKey(name) → { raw, record }`, `mcpkeys.revokeKey(id) → boolean`, `mcpkeys.authenticateKey(raw) → McpKeyRecord | null`.
- Consumes: `hashApiKey` from `auth.ts`; `getSettings`/`updateSettings` from `settings.ts`.

- [ ] **Step 1: Add the MCP key schema + field + type + redaction to `settings.ts`**

Add after the `ApiKeySchema` definition (near line 17):

```ts
const McpKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  prefix: z.string(),
  createdAt: z.string(),
  lastUsed: z.string().nullable().default(null),
  revoked: z.boolean().default(false),
});
```

In `SettingsSchema`, add a `mcp` block immediately after the `api: z.object({...}).default({})` block (near line 75):

```ts
  mcp: z
    .object({
      keys: z.array(McpKeySchema).default([]),
    })
    .default({}),
```

After `export type ApiKeyRecord = ...` (near line 100) add:

```ts
export type McpKeyRecord = z.infer<typeof McpKeySchema>;
```

In `redactSettings` (near line 213), add an `mcp` block after the `api` block so the client never receives hashes:

```ts
    mcp: {
      ...s.mcp,
      keys: s.mcp.keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
        revoked: k.revoked,
      })),
    },
```

- [ ] **Step 2: Write the failing test `server/scripts/verify-mcp-keys.ts`**

```ts
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
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp-keys.ts`
Expected: FAIL — `Cannot find module '../src/services/mcpkeys.js'`.

- [ ] **Step 4: Implement `server/src/services/mcpkeys.ts`**

```ts
import { randomUUID, randomBytes } from 'node:crypto';
import { getSettings, updateSettings, type McpKeyRecord } from './settings.js';
import { hashApiKey } from './auth.js';

/** MCP connection keys — the `?key=` token Claude uses to reach /mcp. Separate
 *  from the `wok_` /api/v1 API keys. Soft-revoke keeps history like the old /admin. */

export async function listKeys(): Promise<Omit<McpKeyRecord, 'hash'>[]> {
  const s = await getSettings();
  return s.mcp.keys.map(({ hash, ...rest }) => rest);
}

export async function createKey(
  name: string,
): Promise<{ raw: string; record: Omit<McpKeyRecord, 'hash'> }> {
  const raw = `mcp_${randomBytes(24).toString('base64url')}`;
  const record: McpKeyRecord = {
    id: randomUUID(),
    name: name || 'MCP connection',
    hash: hashApiKey(raw),
    prefix: raw.slice(0, 12),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    revoked: false,
  };
  await updateSettings((d) => {
    d.mcp.keys.push(record);
  });
  const { hash: _omit, ...safe } = record;
  return { raw, record: safe };
}

export async function revokeKey(id: string): Promise<boolean> {
  let changed = false;
  await updateSettings((d) => {
    const k = d.mcp.keys.find((x) => x.id === id);
    if (k && !k.revoked) {
      k.revoked = true;
      changed = true;
    }
  });
  return changed;
}

/** Look up a raw key; returns the matching active record (and bumps lastUsed). */
export async function authenticateKey(raw: string): Promise<McpKeyRecord | null> {
  if (!raw) return null;
  const hash = hashApiKey(raw);
  const s = await getSettings();
  const match = s.mcp.keys.find((k) => k.hash === hash && !k.revoked);
  if (!match) return null;
  void updateSettings((d) => {
    const k = d.mcp.keys.find((x) => x.id === match.id);
    if (k) k.lastUsed = new Date().toISOString();
  }).catch(() => {});
  return match;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp-keys.ts`
Expected: PASS — all checks `ok`, `N passed, 0 failed`.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/services/settings.ts server/src/services/mcpkeys.ts server/scripts/verify-mcp-keys.ts
git commit -m "feat(server): MCP key store (settings-backed, soft-revoke)"
```

---

## Task 2: Add the MCP SDK dependency + tool adapter

**Files:**
- Modify: `server/package.json`
- Create: `server/src/services/mcptools.ts`

**Interfaces:**
- Consumes: `vault.*`, `qmd` (`search`, `matchesFor`, `allTags`, `upsert`, `remove`), `backlinksFor`, `buildLinkGraph`, `parseNote`, `applyEdit`, `contentVersion`.
- Produces: `createMcpServer(): McpServer` — an `@modelcontextprotocol/sdk` server with the 11 tools registered.

- [ ] **Step 1: Add the SDK dependency**

Edit `server/package.json` dependencies, adding (keep alphabetical near the top):

```json
    "@modelcontextprotocol/sdk": "^1.29.0",
```

Run: `npm install`
Expected: `@modelcontextprotocol/sdk` (and its deps, e.g. `@hono/node-server`) added; no errors.

- [ ] **Step 2: Implement `server/src/services/mcptools.ts`**

Behavior is a faithful port of `webobsidian-mcp/src/mcp.ts`, but each tool calls the in-process service instead of `VaultClient`. Writes reindex via the same `reindex()` pattern used by `routes/agent.ts`.

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as vault from './vault.js';
import { qmd } from './search.js';
import { backlinksFor, buildLinkGraph } from './links.js';
import { applyEdit } from './noteedit.js';
import { contentVersion } from './noteversion.js';

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: 'text', text }] };
}
function fail(e: unknown): ToolResult {
  return { content: [{ type: 'text', text: `Lỗi: ${(e as Error).message}` }], isError: true };
}
const run = (fn: () => Promise<unknown>): Promise<ToolResult> => fn().then(ok).catch(fail);

/** After a write/delete: refresh the search index for the note + the link graph
 *  (mirrors routes/agent.ts `reindex`). Fire-and-forget; never blocks the tool. */
function reindex(rel?: string): void {
  if (rel) void qmd.upsert(rel).catch(() => {});
  void buildLinkGraph().catch(() => {});
}

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: 'webobsidian', version: '0.1.0' });
  const RO = { readOnlyHint: true } as const;
  const DESTRUCTIVE = { destructiveHint: true } as const;

  server.registerTool(
    'health_check',
    { description: 'Kiểm tra WebObsidian còn sống.', inputSchema: {}, annotations: RO },
    () => run(async () => ({ ok: true, service: 'webobsidian-agent-api', version: 'v1' })),
  );

  server.registerTool(
    'list_notes',
    {
      description:
        'Liệt kê đường dẫn note trong vault (phân trang). Lọc theo thư mục bằng folder (tiền tố path).',
      inputSchema: {
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        folder: z.string().optional(),
      },
      annotations: RO,
    },
    ({ offset, limit, folder }) =>
      run(async () => {
        const all = await vault.listMarkdownFiles();
        const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
        const filtered = f ? all.filter((p) => p === f || p.startsWith(f + '/')) : all;
        const off = offset ?? 0;
        const lim = Math.min(limit ?? 100, 200);
        return {
          total: filtered.length,
          offset: off,
          limit: lim,
          folder: f || undefined,
          notes: filtered.slice(off, off + lim),
        };
      }),
  );

  server.registerTool(
    'read_note',
    {
      description:
        "Đọc nội dung note. path case-sensitive, có .md, ví dụ 'Notes/Ideas.md'. Note lớn: đọc theo đoạn bằng " +
        'offset (dòng bắt đầu, 0-based) + limit (số dòng, mặc định 500). Kết quả có version — CẦN version này ' +
        'để write_note (ghi đè). Nếu còn dòng chưa đọc sẽ báo hasMore.',
      inputSchema: {
        path: z.string(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(2000).optional(),
      },
      annotations: RO,
    },
    ({ path, offset, limit }) =>
      run(async () => {
        if (!(await vault.exists(path))) throw new Error(`Not found: ${path}`);
        const content = await vault.readFileText(path);
        const version = contentVersion(content);
        const lines = content.split('\n');
        const totalLines = lines.length;
        const start = Math.max(0, offset ?? 0);
        const lim = Math.min(Math.max(1, limit ?? 500), 2000);
        const slice = lines.slice(start, start + lim);
        const numbered = slice.length
          ? slice.map((ln, i) => `${String(start + i + 1).padStart(6)}\t${ln}`).join('\n')
          : '(đoạn rỗng)';
        const hasMore = start + lim < totalLines;
        const more = hasMore
          ? `\n… còn dòng ${start + lim + 1}–${totalLines}, gọi lại read_note với offset=${start + lim}.`
          : '';
        return `path: ${path}\nversion: ${version}\ntotalLines: ${totalLines}\n---\n${numbered}${more}`;
      }),
  );

  server.registerTool(
    'search_notes',
    {
      description: "Tìm kiếm vault. Hỗ trợ fielded: tag:, path:, title:. Ví dụ 'tag:project'.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(100).optional() },
      annotations: RO,
    },
    ({ query, limit }) =>
      run(async () => ({ query, hits: await qmd.search(query, Math.min(limit ?? 20, 100)) })),
  );

  server.registerTool(
    'grep_note',
    {
      description:
        'Grep TRONG MỘT note đã biết đường dẫn: tìm mọi vị trí khớp query (khớp NGUYÊN VĂN), trả số dòng + ngữ cảnh. ' +
        'BẮT BUỘC truyền path (đường dẫn note, có .md) VÀ query — cả hai đều bắt buộc, không được bỏ trống. ' +
        'Đây KHÔNG phải tìm cả vault: muốn tìm khắp vault thì dùng search_notes trước để ra path, rồi mới grep_note note đó. ' +
        'Dùng để định vị chỗ cần sửa trong note lớn mà không phải đọc toàn bộ, rồi dùng edit_note để sửa.',
      inputSchema: {
        path: z.string(),
        query: z.string().min(1),
        case_sensitive: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
      annotations: RO,
    },
    ({ path, query, case_sensitive, limit }) =>
      run(async () => {
        if (!(await vault.exists(path))) throw new Error(`Not found: ${path}`);
        const m = await qmd.matchesFor(path, [query], {
          caseSensitive: case_sensitive === true,
          maxContexts: Math.min(limit ?? 20, 100),
        });
        if (!m.count) return `Không tìm thấy "${query}" trong ${path}`;
        const lines = m.contexts.map((c) => `dòng ${c.line ?? 1}: ${c.text}`).join('\n');
        return `${m.count} khớp trong ${path}:\n${lines}`;
      }),
  );

  server.registerTool(
    'list_tags',
    { description: 'Liệt kê tất cả tag kèm số lượng.', inputSchema: {}, annotations: RO },
    () => run(async () => ({ tags: qmd.allTags() })),
  );

  server.registerTool(
    'get_backlinks',
    {
      description: 'Liệt kê note liên kết tới path cho trước.',
      inputSchema: { path: z.string() },
      annotations: RO,
    },
    ({ path }) => run(async () => ({ path, backlinks: backlinksFor(path) })),
  );

  server.registerTool(
    'write_note',
    {
      description:
        'Tạo mới hoặc GHI ĐÈ toàn bộ note. PHẢI read_note trước để lấy version rồi truyền vào base_version ' +
        '(chống ghi đè khi note đã đổi). Tạo note MỚI: đặt base_version="". Thao tác phá hủy.',
      inputSchema: { path: z.string(), content: z.string(), base_version: z.string() },
      annotations: DESTRUCTIVE,
    },
    ({ path, content, base_version }) =>
      run(async () => {
        const existed = await vault.exists(path);
        if (existed) {
          const current = contentVersion(await vault.readFileText(path));
          if (base_version !== current)
            throw new Error(`version_conflict (version hiện tại ${current}) — read_note lại rồi thử lại`);
        } else if (base_version !== '') {
          throw new Error('version_conflict — note chưa tồn tại, tạo mới phải đặt base_version=""');
        }
        await vault.writeFileText(path, content);
        reindex(path);
        return `Đã ghi ${path} (version mới ${contentVersion(content)})`;
      }),
  );

  server.registerTool(
    'append_note',
    {
      description: 'Thêm text vào cuối note tại path. Thao tác phá hủy.',
      inputSchema: { path: z.string(), text: z.string() },
      annotations: DESTRUCTIVE,
    },
    ({ path, text }) =>
      run(async () => {
        const existing = (await vault.exists(path)) ? await vault.readFileText(path) : '';
        const joined = existing && !existing.endsWith('\n') ? existing + '\n' + text : existing + text;
        await vault.writeFileText(path, joined);
        reindex(path);
        return `Đã thêm vào ${path}`;
      }),
  );

  server.registerTool(
    'edit_note',
    {
      description:
        'Sửa một đoạn trong note: thay old_string (khớp chính xác từng ký tự) bằng new_string. ' +
        'old_string phải duy nhất trong note, nếu không hãy thêm ngữ cảnh xung quanh hoặc đặt replace_all=true để thay mọi chỗ. ' +
        'An toàn hơn write_note vì không ghi đè phần còn lại của note.',
      inputSchema: {
        path: z.string(),
        old_string: z.string().min(1),
        new_string: z.string(),
        replace_all: z.boolean().optional(),
      },
      annotations: DESTRUCTIVE,
    },
    ({ path, old_string, new_string, replace_all }) =>
      run(async () => {
        if (!(await vault.exists(path))) throw new Error(`Not found: ${path}`);
        const content = await vault.readFileText(path);
        const result = applyEdit(content, old_string, new_string, replace_all === true);
        if ('error' in result) {
          if (result.error === 'find_ambiguous')
            throw new Error(`old_string xuất hiện ${result.count} lần — thêm ngữ cảnh hoặc đặt replace_all=true`);
          throw new Error('Không tìm thấy old_string trong note');
        }
        await vault.writeFileText(path, result.content);
        reindex(path);
        return `Đã sửa ${path} (thay ${result.replaced} chỗ)`;
      }),
  );

  server.registerTool(
    'delete_note',
    {
      description: 'Xóa note (chuyển vào trash). Thao tác phá hủy.',
      inputSchema: { path: z.string() },
      annotations: DESTRUCTIVE,
    },
    ({ path }) =>
      run(async () => {
        if (!(await vault.exists(path))) throw new Error(`Not found: ${path}`);
        const trashed = await vault.trash(path);
        qmd.remove(path);
        reindex();
        return `Đã xóa (vào trash) ${path} → ${trashed}`;
      }),
  );

  return server;
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. (Tool runtime behavior is verified end-to-end in Task 4 with a real MCP client — the meaningful test for MCP tools.)

- [ ] **Step 4: Commit**

```bash
git add server/package.json server/package-lock.json server/src/services/mcptools.ts
git commit -m "feat(server): MCP tool adapter (11 tools over in-process services)"
```

> Note: `package-lock.json` may be at repo root (workspace). `git add` the lock file that actually changed (`git status` shows it).

---

## Task 3: MCP key management REST route + web UI

**Files:**
- Create: `server/src/routes/mcpkeys.ts`
- Modify: `server/src/index.ts` (mount `/api/mcp-keys`)
- Modify: `web/src/lib/api.ts`
- Modify: `web/src/components/Settings.tsx`

**Interfaces:**
- Consumes: `mcpkeys.listKeys/createKey/revokeKey` (Task 1); `requireAuth` middleware; `asyncHandler`.
- Produces: REST `GET/POST/DELETE /api/mcp-keys`; web `api.listMcpKeys/createMcpKey/revokeMcpKey`; Settings `'mcp'` section.

- [ ] **Step 1: Create `server/src/routes/mcpkeys.ts`**

```ts
import { Router } from 'express';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import { listKeys, createKey, revokeKey } from '../services/mcpkeys.js';

export const mcpKeysRouter = Router();
mcpKeysRouter.use(requireAuth);

mcpKeysRouter.get('/', asyncHandler(async (_req, res) => res.json({ keys: await listKeys() })));

mcpKeysRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const name = String(req.body?.name ?? 'MCP connection');
    const { raw, record } = await createKey(name);
    res.json({ key: raw, record }); // raw returned exactly once
  }),
);

mcpKeysRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await revokeKey(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  }),
);
```

- [ ] **Step 2: Mount it in `server/src/index.ts`**

Add the import near the other route imports (near line 23):

```ts
import { mcpKeysRouter } from './routes/mcpkeys.js';
```

Mount it right after the `/api/keys` line (near line 127):

```ts
  app.use('/api/mcp-keys', mcpKeysRouter);
```

- [ ] **Step 3: Add client methods to `web/src/lib/api.ts`**

Right after the `revokeKey` line (near line 237) add:

```ts
  // mcp connection keys
  listMcpKeys: () => req<{ keys: any[] }>('/api/mcp-keys/'),
  createMcpKey: (name: string) =>
    req<{ key: string; record: any }>('/api/mcp-keys/', { method: 'POST', body: JSON.stringify({ name }) }),
  revokeMcpKey: (id: string) => req<{ ok: boolean }>(`/api/mcp-keys/${id}`, { method: 'DELETE' }),
```

- [ ] **Step 4: Add the `'mcp'` section + `<McpKeys/>` to `web/src/components/Settings.tsx`**

4a. Extend the `Section` type (line 6):

```ts
type Section = 'vault' | 'git' | 'api' | 'mcp' | 'sharing' | 'ai' | 'plugins' | 'appearance' | 'account' | 'about';
```

4b. Add `'mcp'` to the sidebar list array (line 25) right after `'api'`:

```ts
            {(['vault', 'git', 'api', 'mcp', 'sharing', 'ai', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
```

4c. Add the render line right after the `section === 'api'` render (near line 34):

```tsx
            {section === 'mcp' && <McpKeys />}
```

4d. Add a label to the `labels` map (near line 51), after `api: 'API Keys',`:

```ts
  mcp: 'MCP',
```

4e. Add the component right after the `ApiKeys` component (after its closing `}` near line 258):

```tsx
function McpKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [name, setName] = useState('Claude – MacBook');
  const [createdUrl, setCreatedUrl] = useState('');
  const load = () => api.listMcpKeys().then((r) => setKeys(r.keys)).catch(() => {});
  useEffect(() => { load(); }, []);
  const create = async () => {
    const r = await api.createMcpKey(name);
    setCreatedUrl(`${location.origin}/mcp?key=${r.key}`);
    await load();
  };
  return (
    <div>
      <h2>MCP</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Kết nối Claude tới vault này qua giao thức MCP. Dán URL vào claude.ai → Settings → Connectors,
        hoặc chạy <code>claude mcp add</code>. URL chứa key bí mật — chỉ hiện một lần.
      </p>
      <Row name="Tên kết nối">
        <input className="text-input" value={name} onChange={(e) => setName(e.target.value)} />
      </Row>
      <button className="btn" onClick={create}>Tạo key</button>
      {createdUrl && (
        <pre style={{ background: 'var(--bg-primary)', padding: 10, borderRadius: 6, marginTop: 10, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
          {createdUrl}
          {'\n'}⚠ Copy ngay — sẽ không hiện lại.
        </pre>
      )}
      <div style={{ marginTop: 16 }}>
        {keys.map((k) => (
          <div className="setting-row" key={k.id}>
            <div className="info">
              <div className="name">
                {k.name} <span style={{ color: 'var(--text-faint)' }}>{k.prefix}…</span>
                {k.revoked && <span style={{ color: '#c0392b', marginLeft: 8 }}>(đã thu hồi)</span>}
              </div>
              <div className="desc">
                tạo: {String(k.createdAt).slice(0, 10)} · dùng gần nhất: {k.lastUsed ?? 'chưa'}
              </div>
            </div>
            {!k.revoked && (
              <button className="btn danger" onClick={async () => { await api.revokeMcpKey(k.id); load(); }}>
                Thu hồi
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Typecheck both workspaces**

Run: `npm run typecheck`
Expected: no errors in server or web.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/mcpkeys.ts server/src/index.ts web/src/lib/api.ts web/src/components/Settings.tsx
git commit -m "feat(web): MCP tab in Settings + /api/mcp-keys route"
```

---

## Task 4: The `/mcp` endpoint + capstone e2e (real MCP client)

**Files:**
- Create: `server/src/routes/mcp.ts`
- Modify: `server/src/index.ts` (mount `/mcp`, SPA-exclusion)
- Create (test): `server/scripts/verify-mcp.ts`

**Interfaces:**
- Consumes: `createMcpServer` (Task 2), `mcpkeys.authenticateKey` (Task 1), `StreamableHTTPServerTransport`.
- Produces: `POST/GET/DELETE /mcp?key=<token>` speaking MCP Streamable HTTP.

- [ ] **Step 1: Implement `server/src/routes/mcp.ts`**

```ts
import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../services/mcptools.js';
import { authenticateKey } from '../services/mcpkeys.js';

/**
 * MCP endpoint (Streamable HTTP, stateless). Auth: `?key=` token or Bearer,
 * verified against the MCP key store. A fresh server+transport is created per
 * request (stateless mode) — matches the retired Cloudflare Worker's model.
 */
export const mcpRouter = Router();

function extractKey(req: Request): string {
  const q = req.query.key;
  if (typeof q === 'string' && q) return q;
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return '';
}

mcpRouter.all('/', async (req: Request, res: Response) => {
  const record = await authenticateKey(extractKey(req));
  if (!record) {
    res
      .status(401)
      .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
```

- [ ] **Step 2: Mount `/mcp` + exclude it from the SPA fallback in `server/src/index.ts`**

Add import near the route imports:

```ts
import { mcpRouter } from './routes/mcp.js';
```

Mount it right after the `/api/v1` agent router (near line 123), so it is registered before the static SPA handler and shares the "no cookie, own auth" neighborhood:

```ts
  app.use('/mcp', mcpRouter); // MCP endpoint (key auth via ?key=)
```

Update the SPA-fallback exclusion (near line 141) to include `/mcp`:

```ts
      if (req.path.startsWith('/api') || req.path.startsWith('/auth') || req.path.startsWith('/public') || req.path.startsWith('/mcp')) return next();
```

- [ ] **Step 3: Write the failing capstone test `server/scripts/verify-mcp.ts`**

```ts
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
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts`
Expected: FAIL before `routes/mcp.ts` is wired (e.g. connect rejected / 404) — confirms the test exercises the real endpoint. (If Step 1–2 are already committed, it should instead PASS; run before wiring to see red, then after to see green.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts`
Expected: PASS — `N passed, 0 failed`, all tool checks `ok`, bad key rejected.

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add server/src/routes/mcp.ts server/src/index.ts server/scripts/verify-mcp.ts
git commit -m "feat(server): in-app /mcp Streamable HTTP endpoint + e2e"
```

---

## Task 5: Documentation + plan/PRD upkeep

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `IMPLEMENTATION_PLAN.md`
- Modify: `docs/AGENT_API.md` (add a short "MCP endpoint" note) OR create `docs/MCP.md`
- Modify: `CLAUDE.md` (note MCP is now in-app)

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a `docs/MCP.md` describing the in-app MCP endpoint**

```markdown
# MCP endpoint (in-app)

WebObsidian serves the Model Context Protocol directly at `POST /mcp?key=<token>`
(Streamable HTTP, stateless). Connect Claude by pasting
`https://<your-host>/mcp?key=<token>` into claude.ai → Settings → Connectors, or
`claude mcp add webobsidian https://<your-host>/mcp?key=<token>`.

Manage connection keys in **Settings → MCP** (create / revoke; the full URL is
shown once). Keys are stored hashed (SHA-256) in `data/settings.json` under `mcp.keys`.

Tools (11): health_check, list_notes, read_note, search_notes, grep_note,
list_tags, get_backlinks, write_note, append_note, edit_note, delete_note.
The four write/delete tools carry `destructiveHint` so Claude confirms first.

This replaces the standalone Cloudflare Worker (`webobsidian-mcp`), which is retired.
```

- [ ] **Step 2: Append a progress entry to `IMPLEMENTATION_PLAN.md`**

Add a dated line under the "Nhật ký tiến độ" section and a checked item recording: "MCP server hosted in-app (`/mcp` + Settings → MCP tab); Cloudflare Worker retired." (Match the file's existing phrasing/format.)

- [ ] **Step 3: Add a one-line note to `CHANGELOG.md`** under the current unreleased/next section: "Add built-in MCP endpoint (`/mcp`) and MCP key management in Settings."

- [ ] **Step 4: Add a note to `CLAUDE.md`** (Cấu trúc / features) that MCP is now served in-app at `/mcp` with keys in Settings → MCP.

- [ ] **Step 5: Typecheck (sanity, no code changed)**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add CHANGELOG.md IMPLEMENTATION_PLAN.md docs/MCP.md CLAUDE.md
git commit -m "docs: document in-app MCP endpoint; note Worker retirement"
```

---

## Out of scope (handled at deploy time, NOT in this branch)

These are **not** part of the merged code (they touch the separate `webobsidian-mcp` repo and the local-only `../_deployments/` docs, or require Henry's action):

- Retiring the Cloudflare Worker (stop deploying; optional 308 redirect to the new URL).
- Updating `../_deployments/webobsidian-mcp.md` and `webobsidian-web.md`.
- Re-adding connectors in Claude Code + claude.ai with the new `https://<host>/mcp?key=` URL (existing Worker connectors break — one-time).

The Phase 5 report will surface these as the remaining manual/deploy steps.

---

## Self-Review

**Spec coverage:**
- "Web app tự nói giao thức MCP" → Task 4 (`/mcp` endpoint) + Task 2 (tools). ✅
- "Key MCP riêng, lưu settings.json, băm SHA-256, soft-revoke" → Task 1. ✅
- "Tab MCP riêng, tạo/thu hồi, URL một lần" → Task 3. ✅
- "11 tool gọi thẳng service nội bộ" → Task 2. ✅
- "Kiểm thử: tsx spawn server + MCP client thật, note tạm tự dọn" → Task 4. ✅
- "Khai tử Worker / re-add connector / _deployments" → Out of scope section (deploy-time). ✅
- "Không thêm DB engine; không đụng /api/v1" → Global Constraints. ✅

**Placeholder scan:** No TBD/TODO; every code step contains full code. ✅

**Type consistency:** `McpKeyRecord` defined in Task 1 (`settings.ts`), consumed by `mcpkeys.ts` (Task 1), `routes/mcpkeys.ts` (Task 3), `routes/mcp.ts` (Task 4). `createMcpServer()` defined Task 2, consumed Task 4. `authenticateKey`/`createKey`/`listKeys`/`revokeKey` names consistent across service, routes, and both verify scripts. `qmd.matchesFor(rel, [q], {caseSensitive, maxContexts})` and `qmd.allTags()`/`qmd.search()`/`backlinksFor()`/`applyEdit()`/`contentVersion()` signatures verified against the real service files. ✅
```
