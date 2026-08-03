import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import * as vault from './vault.js';
import { qmd } from './search.js';
import { backlinksFor, buildLinkGraph } from './links.js';
import { applyEdit } from './noteedit.js';
import { contentVersion } from './noteversion.js';
import { createZip, extractZip, isExcludedFromExport, type OnConflict } from './archive.js';
import { createDownloadTicket, createUploadTicket, getTicket, transferDir, TTL_MS } from './transfer.js';
import { fetchZipToFile } from './fetchzip.js';
import { reindexAfterExtract } from '../routes/transfer.js';

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

const MAX_DOWNLOAD_FILES = 5_000;
const MAX_DOWNLOAD_BYTES = 500 * 1024 * 1024;
const CONFLICT = z.enum(['rename', 'overwrite', 'skip']);

/** Làm phẳng cây vault thành danh sách đường dẫn file. `listTree` đã bỏ dotfile
 *  (`.obsidian`, `.trash`, `.git`) và `node_modules` — đúng ngữ nghĩa loại trừ
 *  ta muốn cho việc đóng gói. */
function flattenTree(node: vault.TreeNode, out: string[] = []): string[] {
  if (node.type === 'file' && node.path) out.push(node.path);
  for (const c of node.children ?? []) flattenTree(c, out);
  return out;
}

async function collectFiles(paths?: string[], folder?: string): Promise<string[]> {
  if (paths?.length) {
    // Danh sách tường minh KHÔNG đi qua listTree nên phải tự lọc dotfile — bỏ
    // bước này chính là lỗ hổng khiến bản fa75f21 bị gỡ khỏi prod (2026-07-31):
    // `.trash/*` và `.obsidian/plugins/*/data.json` tải được.
    const blocked = paths.filter((p) => isExcludedFromExport(p));
    if (blocked.length)
      throw new Error(`Không cho phép đóng gói file ẩn/hệ thống: ${blocked.join(', ')}`);
    const missing: string[] = [];
    for (const p of paths) if (!(await vault.exists(p))) missing.push(p);
    if (missing.length) throw new Error(`Không tìm thấy: ${missing.join(', ')}`);
    return paths;
  }
  const all = flattenTree(await vault.listTree());
  const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
  return f ? all.filter((p) => p === f || p.startsWith(f + '/')) : all;
}

/**
 * `baseUrl` được dựng từ request (protocol + Host) ở `routes/mcp.ts`: tool trả
 * về link tuyệt đối để người dùng bấm được ngay trong claude.ai, và để vault
 * khác fetch được qua `upload_from_url`.
 */
export function createMcpServer(baseUrl: string): McpServer {
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
        'Liệt kê đường dẫn note trong vault (phân trang). Lọc theo thư mục bằng folder (tiền tố path). ' +
        'Sắp xếp bằng sort (name | modified | created) + order (asc | desc); mặc định modified/desc ' +
        '(note sửa gần nhất lên đầu) để note mới không rơi khỏi limit.',
      inputSchema: {
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
        folder: z.string().optional(),
        sort: z.enum(['name', 'modified', 'created']).optional(),
        order: z.enum(['asc', 'desc']).optional(),
      },
      annotations: RO,
    },
    ({ offset, limit, folder, sort, order }) =>
      run(async () => {
        const s = sort ?? 'modified';
        const ord = order ?? (s === 'name' ? 'asc' : 'desc');
        const all = await vault.listMarkdownFilesSorted(s, ord);
        const f = (folder ?? '').replace(/^\/+|\/+$/g, '');
        const filtered = f ? all.filter((p) => p === f || p.startsWith(f + '/')) : all;
        const off = offset ?? 0;
        const lim = Math.min(limit ?? 100, 200);
        return {
          total: filtered.length,
          offset: off,
          limit: lim,
          sort: s,
          order: ord,
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

  server.registerTool(
    'download_files',
    {
      description:
        'Đóng gói file trong vault thành một file ZIP và trả về LINK TẢI tạm thời (30 phút). ' +
        'Chọn bằng paths (danh sách đường dẫn) và/hoặc folder (tiền tố path); bỏ trống cả hai = cả vault. ' +
        'Bỏ qua .trash và dotfile (.obsidian, .git). Lấy được MỌI loại file, kể cả ảnh và file nhị phân. ' +
        'Để chuyển sang vault khác: đưa url trả về đây cho tool upload_from_url của vault đích — ' +
        'nội dung đi thẳng server sang server, không tốn token.',
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
            throw new Error(`Tổng dung lượng vượt giới hạn ${MAX_DOWNLOAD_BYTES} byte`);
          entries.push({ abs, rel });
        }
        const dir = await transferDir();
        const stem = (folder ?? '').replace(/[^\p{L}\p{N} _-]/gu, '').trim() || 'vault';
        const zipPath = path.join(dir, `dl-${Date.now()}-${Math.random().toString(36).slice(2)}.zip`);
        const meta = await createZip(entries, zipPath);
        const t = createDownloadTicket({ zipPath, filename: `${stem}.zip`, ...meta });
        return {
          url: `${baseUrl}/transfer/d/${t.id}`,
          fileCount: meta.fileCount,
          bytes: meta.bytes,
          expiresAt: new Date(t.expiresAt).toISOString(),
          hint: 'Người dùng bấm url này để tải về; hoặc đưa nó cho upload_from_url của vault đích để chuyển tự động.',
        };
      }),
  );

  server.registerTool(
    'upload_from_url',
    {
      description:
        'Tải một file ZIP từ url rồi GIẢI NÉN thẳng vào vault này. Ghép với link do download_files của ' +
        'vault khác sinh ra thì chuyển file giữa hai vault HOÀN TOÀN TỰ ĐỘNG, người dùng không phải thao tác gì ' +
        'và nội dung không đi qua context. Chạy đồng bộ, trả ngay danh sách file đã ghi. ' +
        'on_conflict mặc định rename (không ghi đè file sẵn có). Thao tác phá hủy.',
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
          const result = await extractZip(
            tmp,
            (dest_folder ?? '').replace(/^\/+|\/+$/g, ''),
            (on_conflict ?? 'rename') as OnConflict,
          );
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
        'Tạo link để NGƯỜI DÙNG tải file zip lên vault bằng trình duyệt. Tool này CHƯA ghi gì cả — nó chỉ ' +
        'trả về một URL có hạn 30 phút và dùng đúng một lần; người dùng phải tự mở URL đó rồi kéo file zip vào. ' +
        'Dùng khi file nằm trên máy người dùng. Nếu nguồn là một vault khác thì ĐỪNG dùng tool này — ' +
        'dùng upload_from_url, nó tự động và không cần thao tác tay. ' +
        'Sau khi người dùng báo đã tải xong, gọi transfer_status với ticket trả về ở đây để biết kết quả.',
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
          hint: `Người dùng mở link này và kéo file zip vào. Hết hạn sau ${TTL_MS / 60000} phút, dùng một lần.`,
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
        if (t.kind !== 'upload') throw new Error('Đây là ticket tải, không có trạng thái ghi');
        return { status: t.status, destFolder: t.destFolder || '(gốc vault)', result: t.result, error: t.error };
      }),
  );

  return server;
}
