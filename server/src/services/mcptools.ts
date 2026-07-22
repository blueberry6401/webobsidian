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
