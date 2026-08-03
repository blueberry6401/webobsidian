# MCP vault transfer — download / upload file hàng loạt

Ngày: 2026-08-03
Trạng thái: đã duyệt thiết kế, chờ kế hoạch triển khai

## 1. Vấn đề

MCP hiện có 11 tool, tất cả thao tác **một note text mỗi lần**. Hai việc sau vì thế rất tốn công:

1. **Đẩy một tập file `.md` có sẵn lên vault** — phải gọi `write_note` lặp lại hàng chục lần:
   chậm, và nội dung do model chép lại nên có xác suất sai.
2. **Chuyển file từ vault A sang vault B** — không có đường nào ngoài đọc từng note ở A rồi ghi
   từng note vào B.

Cả hai đều không đụng được tới attachment binary (ảnh, PDF).

## 2. Ràng buộc

- **Client chính là claude.ai (connector web).** Claude ở đó chạy trên máy chủ Anthropic: nó
  **không đọc được ổ cứng người dùng** và **không chạy được `curl`**. Đây là giới hạn vật lý,
  không tool nào vượt qua được.
- **Bytes không được đi qua context của model.** Một zip 5 MB mã hoá base64 thành ~6,7 MB text.
  Mọi thứ nằm trong tham số hoặc kết quả tool đều là token.
- Phạm vi: **mọi loại file** trong vault, gồm cả binary.
- Runtime chỉ dùng file JSON, không thêm DB engine (CLAUDE.md).

Hệ quả trực tiếp của hai ràng buộc đầu: đơn vị truyền là **file ZIP**, và nó phải đi bằng
**HTTP ngoài luồng MCP**. Tool chỉ cấp *link*, không cầm *bytes*.

## 3. Kiến trúc

### 3.1 Luồng vault A → vault B (tự động hoàn toàn)

```
Claude gọi A.download_files({ folder: "Projects" })
  → server A nén Projects thành zip, trả link https://A/transfer/d/<token>
Claude gọi B.upload_from_url({ url: "https://A/transfer/d/<token>" })
  → server B tự HTTP-fetch link đó, giải nén vào vault B
```

Người dùng **không thao tác gì**. Bytes đi thẳng server A → server B, không byte nào qua context,
nên chuyển được vault hàng trăm MB kể cả ảnh đính kèm.

### 3.2 Luồng file trên ổ cứng → vault (dự phòng, có thao tác tay)

```
Claude gọi upload_files({ dest_folder: "Inbox" })
  → trả link https://B/transfer/u/<token>
Người dùng nén file lại, mở link, kéo zip vào → server giải nén vào vault
Claude gọi transfer_status({ ticket }) → biết đã ghi những gì
```

Một thao tác tay cho toàn bộ tập file, thay cho hàng chục lần `write_note`. Luồng này **không thể**
tự động hoá từ claude.ai. Muốn tự động thì dùng Claude Code (chạy trên máy người dùng, đọc được
thư mục) hoặc git sync sẵn có.

### 3.3 Thành phần

| Thành phần | Vai trò |
|---|---|
| `server/src/services/transfer.ts` | Kho ticket trong RAM (Map), sinh token, TTL, dọn rác |
| `server/src/services/archive.ts` | Nén/giải zip theo stream, guard zip-slip, xử lý xung đột |
| `server/src/routes/transfer.ts` | `/transfer/*` — **không auth**, token nằm trong URL |
| `server/src/services/mcptools.ts` | 4 tool mới |

Ticket sống trong RAM chứ không ghi `settings.json`: chúng ephemeral (TTL 30 phút), mất khi restart
là chấp nhận được, và giữ `settings.json` sạch.

Thư viện zip: **`archiver`** (nén) + **`yauzl`** (giải). Cả hai đều stream nên RAM phẳng bất kể vault
to — quan trọng với container Docker giới hạn bộ nhớ. Đánh đổi: 2 dependency thay vì 1 (`adm-zip`
hay `fflate` gọn hơn nhưng nạp toàn bộ vào RAM).

`/transfer` mount **không auth**, đặt cạnh `/share` và `/public/shares` trong `index.ts` — đúng
pattern sẵn có cho route công khai xác thực bằng token trong URL.

## 4. Bề mặt MCP (4 tool mới, tổng 15)

### `download_files({ paths?, folder? })` — `readOnlyHint`

Chọn file theo danh sách `paths` và/hoặc tiền tố `folder`; bỏ trống cả hai = cả vault.
Bỏ qua `.trash`, dotfile (`.obsidian`, `.git`) và `node_modules` — khớp với `vault.listTree()`.

Trả về: URL tải, số file, tổng dung lượng, thời điểm hết hạn.
Từ chối nếu vượt **5 000 file** hoặc **500 MB**.

### `upload_from_url({ url, dest_folder?, on_conflict? })` — `destructiveHint`

Server tự tải zip từ `url` rồi giải nén vào `dest_folder`. Đây là tool làm luồng A→B tự động.
Chạy **đồng bộ**: trả về ngay danh sách file đã ghi / bỏ qua / lỗi. Tool này **không tạo ticket**
và không liên quan tới `transfer_status`.

### `upload_files({ dest_folder?, on_conflict? })` — `destructiveHint`

**Chỉ cấp link, chưa ghi gì.** Trả URL tới một trang HTML tối giản do server render, có ô kéo-thả.
Sau khi giải nén, trang hiện luôn danh sách file đã ghi.

Tên tool hơi sai lệch (nó cấp link chứ không tự đẩy file), nhưng giữ vì model chọn tool dựa nhiều
vào tên. `description` mở đầu bằng "Tạo link để BẠN tải file zip lên…" để model không tưởng rằng
việc đã xong.

### `transfer_status({ ticket })` — `readOnlyHint`

`ticket` là mã do `upload_files` trả về kèm link. Cho biết `pending` | `done` | `error`, kèm danh
sách file đã ghi / bỏ qua / lỗi. Chỉ áp dụng cho ticket đẩy của `upload_files` — không có tool này
thì Claude mù hoàn toàn sau khi đưa link kéo-thả.

Chỉ **hai** loại ticket tồn tại: ticket **tải** (do `download_files` tạo) và ticket **đẩy** (do
`upload_files` tạo). `upload_from_url` không dùng ticket nào.

## 5. Bảo mật

Ta đang mở endpoint **không cần đăng nhập** đọc/ghi được vault, nên đây là phần nặng nhất.

### 5.1 Ticket

- Token 256-bit: `randomBytes(32).toString('base64url')`. Entropy đủ lớn nên tra Map trực tiếp
  là an toàn, không cần so sánh timing-safe.
- TTL mặc định **30 phút**.
- Ticket **tải** dùng được nhiều lần trong TTL (để `upload_from_url` retry được).
- Ticket **đẩy** dùng **đúng một lần**, tiêu huỷ sau khi giải nén thành công.
- Sweeper 5 phút/lần xoá ticket hết hạn kèm file zip. Khởi động server thì dọn sạch `data/transfer/`.
- **Không bao giờ log token.**
- Rate-limit `/transfer/*` bằng `createSlidingWindowCounter` sẵn có.

### 5.2 Zip-slip (rủi ro chí mạng)

Mỗi entry bị từ chối nếu:
- đường dẫn tuyệt đối,
- chứa `..`,
- chứa byte `\0`,
- `vault.resolveInVault()` cho ra đường nằm ngoài vault.

Entry kiểu **symlink bị bỏ qua hoàn toàn**: zip lưu được symlink, và một symlink trỏ ra `/etc` sẽ
biến lần ghi kế tiếp thành ghi đè file hệ thống. Cấm ghi vào `.trash`.

### 5.3 Zip bomb

Dừng và báo lỗi khi vượt **10 000 entry** hoặc **2 GB** sau giải nén.

### 5.4 SSRF cho `upload_from_url`

- Chỉ chấp nhận scheme `http` / `https`.
- Resolve DNS rồi **chặn loopback** (`127.0.0.0/8`, `::1`) và **link-local**
  (`169.254.0.0/16` — chặn `169.254.169.254` metadata cloud — và `fe80::/10`).
- Tối đa **3 redirect**, kiểm IP lại ở **từng hop** (chống DNS rebinding qua redirect).
- Cap **500 MB**, timeout kết nối **15 s**.
- Xác thực là zip bằng **magic bytes `PK\x03\x04`**, không tin `Content-Type`.

**Đánh đổi có ý thức:** không chặn dải LAN riêng (`10/8`, `172.16/12`, `192.168/16`). Hai vault
self-hosted rất có thể cùng mạng nội bộ; chặn là hỏng đúng use case chính. Người gọi đã phải cầm
MCP key hợp lệ nên đây không phải endpoint mở. Rủi ro còn lại: ai chiếm được MCP key có thể dùng
server làm bàn đạp quét LAN — chấp nhận, vì kẻ đó vốn đã đọc/ghi được toàn bộ vault.

### 5.5 Nhận file ở `/transfer/u/:token`

`multer` với **diskStorage** (không phải `memoryStorage` như `/api/files/upload`) ghi thẳng vào
`data/transfer/`, giới hạn 500 MB, đúng 1 file — tránh nạp cả file vào RAM.

## 6. Xung đột & tương thích

- `on_conflict`: **`rename`** (mặc định) → `note.md` thành `note (1).md`, tăng dần; `overwrite`;
  `skip`. Không mất dữ liệu là mặc định đúng cho thao tác chạy không người trực.
- Chuẩn hoá `\` → `/` trong đường dẫn entry (zip tạo trên Windows).
- Tên file tiếng Việt: đọc cờ UTF-8 của zip entry; không có cờ thì fallback CP437.
- Sau khi giải nén: `qmd.upsert` từng file `.md`, `buildLinkGraph()` **một lần cho cả mẻ** (không
  phải mỗi file một lần), và `realtime.broadcast` để tab đang mở tự hiện file mới.
- Chọn rỗng (không file nào khớp) hoặc zip rỗng → báo lỗi rõ ràng, không tạo ticket.

## 7. Kiểm chứng

### Unit test (vitest, đã có sẵn ở `server/`)

- `archive.test.ts` — zip-slip (`../../etc/passwd`, đường dẫn tuyệt đối, backslash, symlink entry);
  ba nhánh `on_conflict`; ngưỡng zip bomb.
- `transfer.test.ts` — TTL hết hạn; ticket đẩy dùng một lần; sweeper dọn file zip.
- `ssrf.test.ts` — loopback, link-local, redirect đổi sang IP bị chặn.

### Kiểm chứng đầu-cuối

Mở rộng `server/scripts/verify-mcp.ts` thành round-trip thật: dựng **2 vault tạm**,
`download_files` ở A → `upload_from_url` ở B → **so khớp byte từng file**, tập mẫu gồm ít nhất một
file binary và một tên file có dấu tiếng Việt.

### Tài liệu

- `docs/MCP.md` — 11 → 15 tool, mô tả `/transfer/*`.
- `PRD.md` — thêm FR + mô tả API (cập nhật **trước** khi code, kèm changelog).
- `IMPLEMENTATION_PLAN.md` — thêm mục, cập nhật tiến độ.

## 8. Ngoài phạm vi

- Mang theo `.obsidian` (theme, plugin, setting) khi clone vault — download bỏ qua dotfile.
- Đồng bộ hai chiều / phát hiện xoá. Đây là copy một chiều, không phải sync.
- Cờ `transfer.allowPrivateNetwork` để siết SSRF về chỉ IP public — thêm sau nếu cần.
- Tool `write_notes` (ghi nhiều note trong một lần gọi, dùng khi đính kèm file thẳng vào khung chat).
