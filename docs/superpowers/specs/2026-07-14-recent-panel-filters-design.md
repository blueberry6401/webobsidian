# Design: Quick filter tên file (File Explorer) + Recent panel 3-mode với filter thời gian

Ngày: 2026-07-14

## Bối cảnh / vấn đề

Vault của người dùng ngày càng nhiều note. Hai vấn đề cụ thể:

1. Không có cách nhanh để lọc cây File Explorer theo tên khi cần tìm 1 note giữa hàng trăm
   file, đặc biệt khi gõ tiếng Việt không dấu.
2. Panel "Recent" hiện tại chỉ show tối đa 20 note **đã từng mở trong phiên trình duyệt này**
   (`recent: string[]` trong `web/src/lib/store.ts`). Nó không phản ánh note nào thực sự mới
   thêm/sửa trong toàn vault — một note bị sửa qua thiết bị khác, qua sync, hoặc chưa được mở lại
   trong phiên hiện tại sẽ không xuất hiện. Người dùng muốn nhìn thấy note nào "mới" theo nghĩa
   filesystem (ngày tạo / ngày sửa), không chỉ theo thao tác mở.

Feature này gồm 2 phần độc lập, có thể build/verify riêng nhưng chia sẻ cùng vault context nên
gộp vào 1 spec.

## Phần 1 — Quick filter tên file trong File Explorer

### Yêu cầu

- Thêm 1 ô input ở đầu panel File Explorer (phía trên cây thư mục hiện có, `FileTree.tsx`).
- Gõ vào ô này sẽ live-filter cây: ẩn ngay các node (file/folder) không khớp; các folder chứa
  file khớp tự động mở rộng để lộ ra đường dẫn tới file đó.
- Match chỉ theo **tên file**, không theo path đầy đủ.
- Chuẩn hóa trước khi so khớp (áp dụng cho cả từ khóa gõ và tên file):
  - Lowercase.
  - Bỏ dấu tiếng Việt: NFD decompose + xóa combining marks (U+0300–U+036F), **cộng thêm** xử lý
    riêng `đ/Đ → d/D` (ký tự này không tách dấu qua NFD).
  - Bỏ toàn bộ khoảng trắng.
  - Sau đó so khớp kiểu "chứa chuỗi con" (substring, không phải fuzzy/skip-char).
  - Ví dụ: gõ `danang` khớp file "Đà Nẵng.md" (chuẩn hóa → `danang`).
- Xóa nội dung ô input → cây trở lại đúng trạng thái mở/đóng folder như trước khi gõ (không
  reset expand state về mặc định).
- Không thay đổi hành vi "Change sort order" đã có sẵn — filter chạy độc lập, áp lên trên kết
  quả đã sort.

### Vị trí trong code

- `web/src/components/FileTree.tsx`: thêm input + state filter, hàm build lại danh sách node
  hiển thị (ẩn node không khớp + tổ tiên của node khớp), điều chỉnh logic auto-expand khi có
  filter active.
- Hàm chuẩn hóa (`normalizeForFilter` hoặc tương tự) nên đặt ở `web/src/lib/` để tái dùng được
  nếu cần (không bắt buộc tái dùng ở đâu khác trong scope này).

## Phần 2 — Panel Recent: 3 mode + filter thời gian

### Yêu cầu

**3 mode** (toggle dạng tab/button-group ở đầu panel, thay cho label tĩnh "Recent"):

1. **Vừa mở** (mặc định khi mở panel) — hành vi cũ: note theo thứ tự vừa mở gần nhất.
2. **Mới tạo** — sort theo `ctime` (ngày tạo file) giảm dần, toàn vault.
3. **Mới sửa** — sort theo `mtime` (ngày sửa file) giảm dần, toàn vault.

**4 nút quick filter thời gian**, dùng chung cho cả 3 mode, đặt cạnh/dưới toggle mode:

- **1 tuần** (mặc định) / **1 tháng** / **3 tháng** / **Tất cả**.
- Filter theo `now - X` so với field thời gian tương ứng của mode đang chọn (`openedAt` cho
  mode Vừa mở; `ctime`/`mtime` cho 2 mode kia).
- Đổi mode không reset lựa chọn filter thời gian (giữ range đang chọn, áp lại cho field mới).

### Mode "Vừa mở" — thay đổi data model

- Hiện tại: `recent: string[]` trong `web/src/lib/store.ts` (dòng ~122, ~373, ~493), cap tại 20
  qua `.slice(0, 20)` khi push path mới lúc mở file.
- Đổi thành: `recent: { path: string; openedAt: number }[]`, cap tại **200** thay vì 20.
- Khi mở file: unshift entry mới `{ path, openedAt: Date.now() }`, loại bỏ entry cũ trùng path,
  slice(0, 200).
- Migration dữ liệu cũ: khi load state từ persisted storage, nếu gặp phần tử là `string` (format
  cũ), convert sang `{ path, openedAt: 0 }` (coi như "rất cũ" — sẽ bị filter thời gian mặc định
  "1 tuần" ẩn đi ngay, không gây nhầm lẫn; chọn "Tất cả" vẫn thấy được).
- `removeRecent(path)` giữ nguyên chức năng (xóa theo path), chỉ đổi kiểu dữ liệu thao tác.

### Mode "Mới tạo" / "Mới sửa" — nguồn dữ liệu

- Không cần thay đổi server / API. Cây file (`GET /api/tree`) đã trả `mtime`/`ctime` sẵn cho mỗi
  file node (`server/src/services/vault.ts`, stat cache có từ Phase 29 — sort-by-time trong file
  tree).
- Client: viết hàm flatten cây hiện có trong store (`tree` state) thành mảng phẳng
  `{ path, name, mtime, ctime }[]` (chỉ file, bỏ folder), lọc theo range đã chọn, sort giảm dần
  theo field tương ứng.
- Không cache riêng — tính lại từ `tree` mỗi khi panel re-render với input thay đổi (chi phí
  chấp nhận được ở quy mô vault cá nhân; không cần memo hóa phức tạp nhưng có thể dùng
  `useMemo` theo `tree` + mode + range để tránh tính lại vô ích khi các state khác đổi).

### UI / tương tác chung cho cả 3 mode

- Click item → mở note (giữ nguyên `openFile`).
- Context menu (chuột phải) giữ nguyên các mục hiện có: Open, Open to the right, Reveal file in
  navigation, Move file to…, Bookmark/Remove bookmark, Copy URL path.
- Mục **"Remove from recent"** chỉ hiển thị ở mode **Vừa mở** (2 mode kia là dữ liệu tự động suy
  ra từ filesystem, không có khái niệm "xóa thủ công" một note khỏi danh sách).
- Rỗng kết quả (không có note nào khớp range đã chọn) → hiện thông báo dạng "Không có note nào
  trong khoảng thời gian này" thay vì để trống trơn.

### Vị trí trong code

- `web/src/components/BookmarksPanel.tsx`: thêm mode toggle + range filter UI phía trên phần
  "Recent" hiện có; đổi logic render danh sách theo mode.
- `web/src/lib/store.ts`: đổi kiểu `recent`, cập nhật các nơi đang push/persist/migrate.

## Non-goals (ngoài phạm vi lần này)

- Không đổi tính năng "Change sort order" sẵn có của File Explorer (đã đáp ứng nhu cầu sort
  trong từng folder, giữ nguyên).
- Không thêm full-text search — đã có `SearchPanel.tsx` riêng cho việc này.
- Không phân trang / lazy-load cho lựa chọn "Tất cả" ở panel Recent — vault cá nhân, số lượng
  note chưa tới mức cần tối ưu thêm.
- Quick filter tên file (Phần 1) không áp dụng cho panel Recent (Phần 2) — hai bộ lọc độc lập,
  không dùng chung UI.

## Đồng bộ tài liệu dự án

Theo quy ước trong `CLAUDE.md` của dự án, đây là tính năng mới ngoài phạm vi PRD.md hiện tại.
Khi chuyển sang implementation plan, phải:

- Thêm 1 mục FR mới vào `PRD.md` (mô tả quick filter tên file + Recent 3-mode) trước khi code.
- Thêm 1 Phase mới vào `IMPLEMENTATION_PLAN.md` với checkbox theo từng mục nhỏ ở Phần 1/Phần 2
  trên, cập nhật "Cập nhật lần cuối" + "Nhật ký tiến độ" khi hoàn thành.

## Testing / verify

- Filter tên file: gõ có dấu, không dấu, không dấu không space, kiểm tra ẩn/hiện đúng + auto
  expand đúng folder chứa kết quả; xóa input trả lại đúng expand state trước đó.
- Recent panel: kiểm tra cả 3 mode × 4 range filter cho ra đúng tập note (so với việc list trực
  tiếp file trên đĩa qua `ls -la --time-style=full-iso` hoặc tương đương để đối chiếu mtime/ctime
  thật). Kiểm tra migration dữ liệu `recent` cũ (format string[]) không làm crash app khi load
  state cũ từ trước khi có thay đổi này.
