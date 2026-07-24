# Spec — List notes: cho AI tự chọn thứ tự sắp xếp

Ngày: 2026-07-24 · Phạm vi: `list_notes` trên cả REST `/api/v1/notes` và tool MCP (FR-6)

## Vấn đề
`list_notes` trả về note theo thứ tự quét thư mục (gần như ABC), cắt ở `limit`
(mặc định 100). Khi vault > limit, note nằm sau bị bỏ khỏi kết quả; AI gọi một
lần và không phân trang sẽ "không thấy" chúng — đặc biệt note mới sửa nhưng tên
xếp muộn theo ABC. `list_notes` được phục vụ ở **hai** nơi, phải sửa cả hai:
- REST `GET /api/v1/notes` (`server/src/routes/agent.ts`) — auth `wok_` key.
- Tool MCP `list_notes` (`server/src/services/mcptools.ts`) — connector claude.ai.

## Giải pháp
Thêm 2 tham số cho AI tự quyết thứ tự, đổi mặc định sang "sửa gần nhất trước".

- `sort`: `name` | `modified` | `created`. Giá trị lạ → `modified`.
- `order`: `asc` | `desc`. Thiếu: `name`→`asc`, `modified`/`created`→`desc`.
- Mặc định tổng thể: `sort=modified`, `order=desc`.
- Giữ nguyên `folder` filter + `offset`/`limit` + `total`. Response thêm
  `sort`/`order`; `notes` vẫn là mảng đường dẫn (string[]) — không phá client.

### Thực thi
- `vault.ts`: tách `collectMarkdownFiles()` (`{rel, abs}`); giữ
  `listMarkdownFiles()`; thêm `listMarkdownFilesSorted(sort, order)`. Sắp theo
  `name` = `localeCompare`; theo thời gian dùng lại `fileStat`/`statCache` (1
  stat/file, cache sau đó), tiebreak theo tên cho ổn định.
- `agent.ts` và `mcptools.ts`: đọc `sort`/`order`, gọi hàm mới, giữ folder+trang.

## Không làm (YAGNI)
Không đổi `notes` thành object; không nhúng ngày vào từng note.

## Tài liệu cập nhật cùng lần
`docs/agent-skill/webobsidian/SKILL.md`, `docs/MCP.md`, `PRD.md` (FR-6),
`IMPLEMENTATION_PLAN.md` (Phase 34).

## Kiểm thử end-to-end
Chạy server thật (login → tạo `wok_` key → gọi endpoint) với vault có mtime
kiểm soát; xác nhận thứ tự đúng cho name/modified/created + asc/desc, phân trang,
và fallback khi tham số lạ. Mặc định phải là modified-desc.
