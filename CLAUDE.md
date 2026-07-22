# CLAUDE.md — Hướng dẫn làm việc cho Claude Code trên dự án WebObsidian

## Bối cảnh
WebObsidian là web app self-hosted clone toàn diện Obsidian. Thiết kế chính thức nằm ở
[PRD.md](PRD.md). Tiến độ phát triển được track ở [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Nguyên tắc bắt buộc (đọc trước mỗi phiên làm việc)

1. **Luôn bám sát PRD.md.** Trước khi code một tính năng, đối chiếu với phần FR/NFR/API/data
   model tương ứng trong PRD. Không tự ý đổi kiến trúc hay phạm vi. Nếu thấy cần lệch khỏi PRD,
   **cập nhật PRD.md trước** (ghi rõ lý do, tăng version/changelog) rồi mới code.

2. **Luôn cập nhật IMPLEMENTATION_PLAN.md.** Mỗi khi bắt đầu hoặc hoàn thành một mục:
   - Đổi checkbox: `[ ]` → `[~]` (đang làm) → `[x]` (xong).
   - Cập nhật dòng "Cập nhật lần cuối" và thêm dòng vào "Nhật ký tiến độ" (ngày + tóm tắt).
   - Một mục chỉ đánh `[x]` khi code chạy được/được kiểm chứng, không phải khi mới viết xong.

3. **Đồng bộ với todo list của session.** Todo nội bộ phải phản ánh các mục trong plan.

4. **Tài liệu là nguồn sự thật.** Khi phạm vi thay đổi theo yêu cầu người dùng: cập nhật PRD.md
   (thiết kế) và IMPLEMENTATION_PLAN.md (thêm/sửa mục) trong cùng lần thay đổi.

## Quy ước kỹ thuật
- Ngôn ngữ: TypeScript cho cả server và web. Tránh `any` khi có thể.
- Cấu hình runtime: chỉ dùng file JSON (`data/settings.json`) — không thêm DB engine.
- Bảo mật: không log secret/token/API key; hash trước khi lưu; guard path traversal.
- Commit/push git **chỉ khi người dùng yêu cầu**.

## Lệnh hữu ích
```bash
npm install            # cài deps toàn workspace
npm run dev            # chạy server + web (dev)
npm run build          # build web rồi server
npm run start          # chạy production (server serve web đã build)
npm run typecheck      # kiểm tra type cả 2 workspace
docker compose up      # chạy full stack
```

## Cấu trúc (xem PRD §2.2)
- `server/` — Express API (routes, services, middleware, plugins shim).
- `web/` — React SPA (components, lib, styles).
- `data/` — runtime config & index (gitignored).
- `docs/` — tài liệu bổ sung. Xem `docs/RUNNING.md` để chạy dev/production từ đầu.

## MCP (server nhúng trong web app, từ 2026-07-22)
- Web app tự phục vụ giao thức MCP tại `POST /mcp?key=<token>` (Streamable HTTP stateless,
  `server/src/routes/mcp.ts` + `services/mcptools.ts`). **Cloudflare Worker `webobsidian-mcp` đã khai
  tử** — đừng deploy lại nó. Chi tiết: `docs/MCP.md`.
- Key kết nối MCP tách riêng khỏi API key `wok_`: lưu `data/settings.json` (`mcp.keys`, băm SHA-256,
  soft-revoke — `services/mcpkeys.ts`), quản lý ở tab **Settings → MCP**.
- Verify: `cd server && ../node_modules/.bin/tsx scripts/verify-mcp.ts` (server thật + MCP client thật).

## Remote git
- **⚠️ BẮT BUỘC — LÀM ĐẦU TIÊN MỖI PHIÊN: base code trên `fork/main`, KHÔNG tin nhánh worktree
  hiện tại.** Worktree tạm rất hay được tạo ở một commit CŨ, tụt lại sau `fork/main` cả trăm
  commit (đã dính lỗi này NHIỀU lần). `fork/main` mới là nguồn sự thật đang chạy prod. Nếu code
  trên base cũ rồi push thẳng sẽ **làm prod thụt lùi**. Quy trình đúng:
  ```bash
  git fetch fork
  git rev-list --left-right --count fork/main...HEAD   # số bên trái > 0 ⇒ ĐANG TỤT SAU
  git reset --hard fork/main                            # đưa worktree về đúng base trước khi sửa
  ```
  Chạy 3 lệnh này TRƯỚC khi đọc/sửa bất kỳ file nào. Chỉ khi `fork/main...HEAD` cho `0 0` (hoặc
  chỉ có commit của chính phiên này ở bên phải) mới được tin nhánh hiện tại.
- `origin` = repo gốc upstream (`xnohat/webobsidian`) — chỉ đọc/tham khảo, không push trừ khi
  người dùng yêu cầu rõ.
- `fork` = repo riêng của người dùng (`blueberry6401/webobsidian`) — đích push mặc định cho các
  fix/tính năng. `gh` đã auth sẵn trên máy này với tài khoản `blueberry6401`
  (`gh auth setup-git` đã chạy để `git push` qua HTTPS dùng token của gh).
- Dev thường làm trong git worktree tạm (`.claude/worktrees/<session>/`) — nhánh đó **bị xoá**
  khi session đóng, nên fix phải được merge vào `main` ở checkout gốc (và push lên `fork`)
  trước khi kết thúc phiên, không được để trôi nổi chỉ trong worktree.
- Tài liệu deploy production nằm ở `../_deployments/` (thư mục docs, KHÔNG phải clone): mỗi
  service một file — `webobsidian-web.md` (server droplet DigitalOcean 159.65.128.188, deploy
  qua `ssh root@... 'cd /opt/webobsidian && git pull && docker compose up -d --build'`) và
  `webobsidian-mcp.md` (Worker Cloudflare, deploy qua `wrangler deploy`). ĐỌC file tương ứng
  trước khi deploy.
