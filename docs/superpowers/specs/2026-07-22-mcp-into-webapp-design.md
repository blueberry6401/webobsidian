# Gộp MCP server vào web app WebObsidian (khai tử Worker Cloudflare)

- **Ngày:** 2026-07-22
- **Repo chính chịu tác động:** `webobsidian` (web app self-hosted, Express + React)
- **Repo nghỉ hưu:** `webobsidian-mcp` (Cloudflare Worker)

## 1. Bối cảnh & mục tiêu

Hiện MCP đi **2 chặng**: Claude → Worker Cloudflare (`webobsidian-mcp.hiep95-mcp.workers.dev`,
dịch giao thức MCP → REST) → web app droplet (`/api/v1`). Worker chỉ là kẻ trung gian dịch giao
thức và giữ `WEBOBSIDIAN_API_KEY` (`wok_…`) để gọi REST. Key kết nối của Claude (`?key=…`) lưu ở
Cloudflare KV, quản lý ở trang `/admin` tách biệt.

**Mục tiêu:** web app **tự phục vụ giao thức MCP**, tự lưu & quản lý key kết nối trong store của
chính nó (file JSON, theo quy ước dự án — **không thêm DB engine**). Sau khi bản mới chạy thật,
**ngừng dùng Worker Cloudflare hoàn toàn**.

Sau khi xong: Claude kết nối thẳng `https://obsidian.henry-group.uk/mcp?key=<key>`; 14 tool gọi
thẳng tầng service nội bộ (bỏ 1 cú nhảy mạng, không cần `wok_` trung gian cho MCP).

## 2. Kiến trúc

### Trước
```
Claude ──MCP/HTTP──▶ Worker CF (mcp.ts + admin.ts + KV MCP_KEYS)
                         │  X-API-Key: wok_…
                         ▼
                     web app /api/v1 (droplet)
```

### Sau
```
Claude ──MCP/HTTP (?key=…)──▶ web app droplet
                                 ├─ POST /mcp        endpoint MCP (Streamable HTTP, stateless)
                                 ├─ services/mcpkeys quản lý key MCP (băm SHA-256, lưu settings.json)
                                 ├─ services/mcptools 14 tool gọi thẳng vault/search/links/noteedit
                                 └─ web: tab "MCP" trong Cài đặt (tạo/thu hồi key, hiện URL kết nối)
```

Không còn Worker, không còn KV, không còn `wok_` cho đường MCP. REST `/api/v1` **giữ nguyên** cho
mọi consumer khác (không đụng tới).

## 3. Các thành phần cần xây (server)

### 3.1. Kho key MCP — `server/src/services/mcpkeys.ts`
Mô phỏng `apikeys.ts` nhưng **tách riêng** (Henry chọn key riêng, không trộn với API Keys).

- Thêm block `mcp` vào `SettingsSchema` (`server/src/services/settings.ts`):
  ```
  mcp: { keys: McpKeyRecord[] }
  McpKeyRecord = { id, name, hash, prefix, createdAt, lastUsed, revoked }
  ```
- Tái dùng `generateApiKey()` / `hashApiKey()` trong `auth.ts` để sinh & băm (raw dạng `wok_…`
  vẫn ổn; hoặc thêm tiền tố riêng `mcp_…` cho dễ phân biệt — quyết trong lúc code, không đổi kiến trúc).
- Hàm: `listKeys()`, `createKey(name)` → `{ raw, record }` (raw hiện đúng **một lần**),
  `revokeKey(id)` (**soft-revoke**: set `revoked=true`, giữ lại để hiện lịch sử như trang `/admin` cũ),
  `authenticateKey(raw)` → record hợp lệ & chưa revoked, best-effort cập nhật `lastUsed`.

### 3.2. Adapter tool — `server/src/services/mcptools.ts`
14 tool MCP, **gọi thẳng service nội bộ** thay vì HTTP. Ánh xạ trực tiếp từ logic đã có trong
`server/src/routes/agent.ts`:

| Tool | Backend nội bộ |
|---|---|
| `health_check` | trả `{ok:true, service, version}` |
| `list_notes` | `vault.listMarkdownFiles()` + phân trang/lọc folder |
| `read_note` | `vault.readFileText` + `noteversion` (version) + cắt đoạn offset/limit + đánh số dòng |
| `search_notes` | `qmd.search` |
| `grep_note` | grep nội văn trên `vault.readFileText` |
| `list_tags` | `qmd.allTags()` |
| `get_backlinks` | `backlinksFor` |
| `write_note` | kiểm tra `base_version` qua `noteversion` → `vault.writeFileText` |
| `append_note` | đọc + nối + `vault.writeFileText` |
| `edit_note` | `noteedit` (find/replace nguyên tử) |
| `delete_note` | `vault.trash` |

Giữ nguyên tên tool, mô tả tiếng Việt, `inputSchema` (zod), và annotation `readOnlyHint` /
`destructiveHint` **y hệt** `webobsidian-mcp/src/mcp.ts` để hành vi phía Claude không đổi.

### 3.3. Endpoint MCP — `server/src/routes/mcp.ts`
- Dùng `@modelcontextprotocol/sdk`: `McpServer` (đăng ký tool từ `mcptools.ts`) +
  `StreamableHTTPServerTransport` ở chế độ **stateless** (`sessionIdGenerator: undefined`), tạo
  server + transport mới mỗi request — hợp với Express nhiều tiến trình/droplet.
- **Auth:** đọc `?key=` (hoặc header `Authorization: Bearer`) → `mcpkeys.authenticateKey` → 401 nếu
  sai. Không dùng cookie/session của web UI.
- Mount ở `server/src/index.ts` **trước** middleware gate và thêm `/mcp` vào danh sách loại trừ
  SPA-fallback (cạnh `/api`, `/auth`, `/public`).
- Thêm `@modelcontextprotocol/sdk` (+ `zod` đã có) vào `server/package.json`.

## 4. Web UI — tab "MCP" (`web/src/components/Settings.tsx`)
- Thêm `'mcp'` vào `Section`, vào mảng render, và nhãn `labels`.
- Component `<McpKeys/>` (mô phỏng `<ApiKeys/>` sẵn có + trang `/admin` cũ):
  - Bảng: Tên · Trạng thái (badge Đang hoạt động / Đã thu hồi) · Tạo lúc · Dùng gần nhất · [Thu hồi].
  - Form **Tạo key** (nhập tên) → hiện **full URL** `https://<host>/mcp?key=<raw>` đúng một lần,
    nút Copy.
  - Ghi chú ngắn: cách dán vào claude.ai → Connectors và `claude mcp add`.
- API client `web/src/lib/api.ts`: `listMcpKeys` / `createMcpKey` / `revokeMcpKey`.
- Route quản lý: `server/src/routes/mcpkeys.ts` (`GET/POST/DELETE /api/mcp-keys`, `requireAuth`
  = cookie đăng nhập web), mount trong `index.ts`.

## 5. Di trú & khai tử Worker
- **Kết nối cũ đứt (không tránh được):** URL đổi `…workers.dev/mcp` → `obsidian.henry-group.uk/mcp`.
  Sau deploy: Henry tạo key mới trong tab MCP rồi cắm lại ở **Claude Code (Mac)** và **claude.ai
  web/mobile**. Chuyện một lần.
- **Worker nghỉ hưu:** sau khi bản web app chạy thật + verify, ngừng deploy Worker. Repo
  `webobsidian-mcp` giữ làm lưu trữ; tùy chọn thêm redirect 308 sang URL mới cho gọn (không bắt buộc).
- Cập nhật docs deploy `../_deployments/` (web + mcp) phản ánh MCP giờ nằm trong web app.

## 6. Kiểm thử (theo quy ước repo server: script `tsx` spawn server thật + HTTP thật)
- `server/scripts/verify-mcp.ts`: spawn server thật → đăng nhập lấy cookie → tạo key MCP qua
  `/api/mcp-keys` → dùng **MCP client thật** (`@modelcontextprotocol/sdk` client + Streamable HTTP)
  nối `/mcp?key=<raw>` → chạy vòng: `list_notes` → `write_note` (note tạm tên duy nhất) →
  `read_note` → `edit_note` → `grep_note` → `delete_note`. Tự dọn note tạm. Kiểm 401 khi key sai/thu hồi.
- `npm run typecheck` cả server + web.
- **E2E thật như người dùng** (yêu cầu bắt buộc của Henry): sau deploy droplet, cắm URL mới vào
  Claude Code, gọi thử vài tool đọc/ghi trên vault thật, xác nhận `health_check` trả version.

## 7. Ngoài phạm vi (YAGNI)
- Không đổi `/api/v1` REST, không đổi hệ thống API Keys `wok_` hiện có.
- Không làm OAuth cho MCP (giữ mô hình `?key=` như hiện tại).
- Không viết lại UI trang `/admin` cũ; nó chết cùng Worker.
- Không thêm DB engine — chỉ `settings.json`.

## 8. Tiêu chí hoàn thành
1. `POST /mcp?key=<key hợp lệ>` handshake MCP OK; key sai/thu hồi → 401.
2. 14 tool chạy đúng trên vault thật (đọc/ghi/sửa/xóa/search/backlink/tag).
3. Tab MCP trong Cài đặt tạo/thu hồi key và hiện URL kết nối một lần.
4. `verify-mcp.ts` + `typecheck` xanh; Claude Code cắm URL mới dùng được thật.
5. Worker ngừng deploy; docs deploy cập nhật.
