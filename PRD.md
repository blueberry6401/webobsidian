# PRD — WebObsidian

> Product Requirements Document
> Phiên bản: 0.1 · Cập nhật: 2026-06-03 · Trạng thái: Draft

---

## 1. Tổng quan

**WebObsidian** là một web app self-hosted clone toàn diện chức năng của [Obsidian](https://obsidian.md), chạy trên server (Docker), thao tác trực tiếp trên một thư mục Vault chứa các file Markdown. Mục tiêu là cho phép truy cập và chỉnh sửa "second brain" của người dùng từ bất kỳ trình duyệt nào, đồng thời mở API cho AI Agent tương tác.

### 1.1 Mục tiêu (Goals)
- Trải nghiệm soạn thảo/đọc Markdown tương đương Obsidian desktop (editor, live preview, wikilinks, graph, backlinks).
- Vault là một thư mục thực trên server — tương thích 100% với vault Obsidian hiện có (kể cả `.obsidian/`).
- Sync 2 chiều bằng **GitHub repo native** (git), hỗ trợ **Git LFS** cho file lớn (ảnh, pdf, audio…).
- **Login gate** đơn giản: một mật khẩu duy nhất bảo vệ toàn bộ app.
- Cấu hình lưu trong **file `.json` thuần** (không cần DB engine).
- **API Gate** với API key để AI Agent đọc/ghi/tìm kiếm vault qua REST.
- **QMD search engine** tích hợp sẵn: full-text + fielded search nhanh trên toàn vault.
- Hỗ trợ cài **Obsidian community plugins** giống app chuẩn (qua plugin loader + Obsidian API shim).
- Đóng gói **Docker stack** chạy 1 lệnh.

### 1.2 Ngoài phạm vi (Non-goals — v1)
- Realtime multi-user collaborative editing (CRDT). v1 là single-user (1 password).
- Obsidian Sync/Publish độc quyền (thay bằng Git sync).
- Mobile native app (chỉ responsive web).
- 100% tương thích mọi plugin dùng Electron/Node API nội bộ (chỉ hỗ trợ subset Obsidian API phổ biến).

### 1.3 Người dùng mục tiêu
- Cá nhân tự host knowledge base, muốn truy cập từ mọi thiết bị qua web.
- Người dùng muốn AI Agent đọc/ghi vault qua API an toàn.

---

## 2. Kiến trúc hệ thống

```
┌─────────────────────────────────────────────────────────────┐
│                        Browser (SPA)                          │
│   React + CodeMirror 6 · Live Preview · File Tree · Graph     │
└───────────────▲───────────────────────────┬──────────────────┘
                │ REST + WebSocket           │ static assets
┌───────────────┴───────────────────────────▼──────────────────┐
│                   Server (Node + Express + TS)                │
│  Auth gate │ Vault FS │ QMD Search │ Git Sync │ API Gate │     │
│            │          │            │          │ Plugins  │     │
└───┬─────────────┬──────────┬────────────┬──────────────┬──────┘
    │             │          │            │              │
 settings.json   Vault dir  Search index  GitHub repo   plugins dir
 (JSON db)       (.md+attach) (in-mem/disk) (git+LFS)    (.obsidian/plugins)
```

### 2.1 Tech stack
| Layer | Lựa chọn | Lý do |
|-------|----------|-------|
| Backend | Node 20+, Express, TypeScript | Đồng nhất ngôn ngữ, hệ sinh thái git/markdown phong phú |
| Frontend | React + Vite + TypeScript | Build nhanh, SPA |
| Editor | CodeMirror 6 | Engine soạn thảo của chính Obsidian |
| Markdown | unified/remark + rehype | Render an toàn, hỗ trợ plugin |
| Search | QMD (module nội bộ trên nền MiniSearch) | Full-text + fielded, in-process, không cần service ngoài |
| Sync | simple-git + git-lfs | Native git, hỗ trợ file lớn |
| Auth | Mật khẩu hash (scrypt) + JWT cookie | Đơn giản, không cần DB |
| Storage cfg | `data/settings.json` | Yêu cầu "JSON thuần" |
| Container | Docker + docker-compose | Deploy 1 lệnh |

### 2.2 Layout thư mục dự án
```
webobsidian/
├── server/           # API backend
│   └── src/
│       ├── routes/       # auth, files, search, sync, api(agent), plugins
│       ├── services/     # vault, search(QMD), git, settings, auth, plugins
│       ├── middleware/   # auth guard, apikey guard, error handler
│       └── plugins/      # Obsidian API shim + loader
├── web/              # React SPA
│   └── src/
│       ├── components/   # FileTree, Editor, Preview, SearchPanel, Settings…
│       ├── lib/          # api client, store, markdown
│       └── styles/
├── data/             # runtime: settings.json, apikeys, sessions (gitignored)
├── docs/
├── docker-compose.yml
└── Dockerfile
```

---

## 3. Yêu cầu chức năng (Functional Requirements)

### FR-1 · Vault management
- Chọn/đổi thư mục Vault qua Settings (đường dẫn server-side, có folder browser an toàn trong allowed roots).
- CRUD file & folder: tạo, đọc, ghi, đổi tên, di chuyển, xoá (xoá → `.trash`).
- Hỗ trợ attachments (ảnh/pdf/…); upload từ web.
- Watch filesystem (chokidar) để phản ánh thay đổi ngoài (git pull, sửa trực tiếp).
- Tương thích cấu trúc `.obsidian/` (config, plugins, themes).

### FR-2 · Editor & rendering
- CodeMirror 6: syntax highlight Markdown, keybindings cơ bản.
- Live preview / Reading view chuyển đổi.
- Wikilinks `[[note]]`, embeds `![[file]]`, tags `#tag`, callouts, tasks `- [ ]`.
- Backlinks panel, outline, tag pane.
- Graph view (lực đẩy, từ wikilinks).

### FR-3 · Login gate
- Lần đầu chạy: set master password.
- Đăng nhập 1 password → JWT trong httpOnly cookie.
- Mọi route web & file API yêu cầu auth (trừ `/login`, healthcheck).

### FR-4 · GitHub sync
- Cấu hình: repo URL, branch, token (PAT) hoặc deploy key, tên/email commit.
- Thao tác: init/clone, pull, commit-all, push; hiển thị status (ahead/behind/dirty).
- Auto-sync tuỳ chọn theo interval + on-save debounce.
- Git LFS: cấu hình `.gitattributes` cho pattern lớn; track/push LFS.
- Conflict: phát hiện, báo người dùng, chiến lược merge cơ bản (ưu tiên hỏi).

### FR-5 · Settings (JSON db)
- Toàn bộ cấu hình trong `data/settings.json` (atomic write, có backup).
- Nhóm: vault, auth, git, search, api, ui, plugins.
- UI Settings để xem/sửa; validate bằng schema (zod).

### FR-6 · API Gate (AI Agent)
- Quản lý nhiều **API key** (tạo/thu hồi, scope: read / write / search).
- REST endpoints `/api/v1/*` xác thực bằng header `Authorization: Bearer <key>` hoặc `X-API-Key`.
- Năng lực: list notes, read note, create/update/delete note, search, get backlinks, append.
- Rate limit + audit log mỗi key.

### FR-7 · QMD Search engine
- Index toàn bộ `.md`: nội dung, tiêu đề, headings, tags, path, frontmatter.
- Truy vấn: full-text, prefix, fuzzy, fielded (`tag:`, `path:`, `title:`), boolean.
- Cập nhật incremental khi file thay đổi (qua watcher).
- Index lưu/khôi phục trên disk (`data/qmd-index.json`) để khởi động nhanh.

### FR-8 · Community plugins
- Đọc danh sách plugin từ `.obsidian/plugins/*` (manifest.json, main.js).
- Plugin loader nạp `main.js` trong sandbox với **Obsidian API shim** (App, Vault, Workspace, Plugin, Notice, Setting…).
- Browse & cài plugin từ community list (qua GitHub releases) — tải về thư mục plugins.
- Bật/tắt plugin; lưu trạng thái trong settings.

### FR-9 · Docker
- `Dockerfile` multi-stage (build web + server → image gọn).
- `docker-compose.yml`: mount vault volume, data volume, env cho password/secret.
- Healthcheck, restart policy.

---

## 4. Yêu cầu phi chức năng (NFR)
- **Bảo mật**: password hash scrypt, JWT secret tự sinh, API key hash khi lưu, path traversal guard, CORS hạn chế, rate limiting.
- **Hiệu năng**: search < 100ms cho vault ~10k notes; lazy load file tree lớn.
- **Tin cậy**: atomic writes cho settings & notes; backup trước ghi đè; git ops không mất dữ liệu.
- **Khả chuyển**: chạy được trên Linux/macOS, ARM & x86.
- **Khả dụng**: responsive (desktop/tablet/mobile), dark/light theme.

---

## 5. API surface (tóm tắt)

### Web/session API (cookie auth)
```
POST   /auth/setup            # set password lần đầu
POST   /auth/login            # login → cookie
POST   /auth/logout
GET    /auth/me
GET    /api/files            # cây thư mục
GET    /api/files/*path      # đọc file (md/binary)
PUT    /api/files/*path      # ghi
POST   /api/files/*path      # tạo / upload
PATCH  /api/files            # rename/move
DELETE /api/files/*path      # xoá → trash
GET    /api/search?q=...
GET    /api/backlinks?path=...
GET    /api/git/status | POST /api/git/{pull,commit,push,sync}
GET/PUT /api/settings
GET/POST/DELETE /api/keys     # quản lý API key
GET    /api/plugins | POST /api/plugins/install | PATCH enable
```

### Agent API (API-key auth) — `/api/v1`
```
GET    /api/v1/notes                 # list (paginate)
GET    /api/v1/notes/{path}          # read
PUT    /api/v1/notes/{path}          # create/update
PATCH  /api/v1/notes/{path}/append   # append content
DELETE /api/v1/notes/{path}
GET    /api/v1/search?q=...&limit=
GET    /api/v1/backlinks?path=
GET    /api/v1/tags
```

---

## 6. Data model — `settings.json`
```jsonc
{
  "version": 1,
  "auth":   { "passwordHash": "scrypt$...", "jwtSecret": "..." },
  "vault":  { "path": "/vault", "allowedRoots": ["/vault"], "trash": ".trash" },
  "git":    { "enabled": false, "remote": "", "branch": "main",
              "token": "", "authorName": "", "authorEmail": "",
              "autoSync": false, "intervalSec": 300,
              "lfsPatterns": ["*.png","*.jpg","*.pdf","*.mp4"] },
  "search": { "fuzzy": 0.2, "indexFrontmatter": true },
  "api":    { "keys": [ { "id": "...", "name": "agent1",
                          "hash": "...", "scopes": ["read","search"],
                          "createdAt": "...", "lastUsed": "..." } ],
              "rateLimitPerMin": 120 },
  "ui":     { "theme": "obsidian-dark", "defaultView": "live" },
  "plugins":{ "enabled": ["dataview"], "installed": [] }
}
```

---

## 7. Rủi ro & quyết định
- **Tương thích plugin**: nhiều plugin dùng API/DOM Electron riêng → chỉ đảm bảo subset. Quyết định: shim API phổ biến, fail mềm với API thiếu, log cảnh báo.
- **Bảo mật token git/API key**: lưu trong settings.json server-side (chmod 600), khuyến nghị mount qua secret/volume riêng.
- **File lớn**: bắt buộc Git LFS; cảnh báo khi commit file > ngưỡng mà chưa track LFS.
- **Đồng bộ xung đột**: v1 ưu tiên thông báo + manual resolve, không auto-merge phá dữ liệu.

---

## 8. Tiêu chí hoàn thành (Definition of Done) cho v1
1. Đăng nhập 1 password, mở vault, xem cây thư mục.
2. Mở/sửa/tạo/xoá note với editor + live preview + wikilinks/backlinks.
3. Search trả kết quả từ QMD < 100ms trên vault mẫu.
4. Cấu hình git, sync (pull/commit/push) thành công kể cả file LFS.
5. Tạo API key, AI Agent gọi `/api/v1` đọc/ghi/search thành công.
6. Cài & bật ít nhất 1 community plugin đơn giản.
7. `docker compose up` chạy toàn bộ stack.
