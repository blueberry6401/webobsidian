# Design — HTML Preview (LLM-generated, per-note)

> Ngày: 2026-07-08 · Trạng thái: Approved (chờ viết implementation plan)

## 1. Mục tiêu

Cho phép người dùng tạo **bản xem trước HTML** cho một note `.md`, sinh ra bởi LLM (Anthropic
Claude hoặc OpenAI) dựa trên nội dung note + một prompt hướng dẫn. Đây **không phải** là export
tĩnh 1-lần: HTML sinh ra được gắn với note gốc, người dùng xem được nó có đang **lệch (out of
sync)** so với nội dung note hiện tại hay không, và có thể **tạo lại** bất cứ lúc nào. Một note có
thể có **nhiều bản preview khác nhau**, mỗi bản ứng với một prompt/template khác nhau (ví dụ: "bản
cho khách", "bản chi tiết kỹ thuật").

Ví dụ dùng thực tế: note `Trips/Timeline/Jul26 - Tay Nguyen tu Da Lat/Timeline.md` → prompt "Đây là
lộ trình di chuyển, tạo file html để preview nhanh chóng, giúp tôi liếc qua là nắm được lộ trình +
bấm vào ra Google Maps link luôn" → HTML timeline trực quan, click ra Google Maps.

## 2. Phạm vi (Scope)

**Trong phạm vi v1:**
- Cấu hình API key Anthropic **và** OpenAI trong Settings, chọn provider đang active.
- Quản lý template prompt (CRUD) trong Settings, dùng lại nhiều lần.
- Trigger tạo preview từ menu "⋯" của pane note đang mở (chỉ áp dụng file `.md`).
- Một note có nhiều preview, mỗi preview có tên riêng, rename/delete được.
- Xử lý **nền + polling**: bấm Generate là có phản hồi ngay (trạng thái "đang tạo"), phản ánh đúng
  trạng thái kể cả khi **reload trang giữa chừng**.
- Badge "out of sync" khi nội dung note đã đổi so với lúc tạo preview + nút "Tạo lại".
- Preview mở trong tab riêng của app (iframe cách ly), cạnh tab note.

**Ngoài phạm vi (non-goals) v1:**
- Không chia sẻ public bản HTML preview (khác tính năng "Share…" hiện có cho note/canvas).
- Không áp dụng cho file `.canvas`, chỉ `.md`.
- Không hỗ trợ provider LLM khác ngoài Anthropic/OpenAI (không làm base-URL tuỳ chỉnh).
- Không giới hạn/cảnh báo chi phí gọi API (người dùng tự quản lý key của họ).
- Không cần bộ test tự động — dự án hiện kiểm thử thủ công end-to-end (đúng quy ước sẵn có).

## 3. Kiến trúc xử lý

**Xử lý nền + polling**, không chờ request gốc treo tới khi LLM trả lời xong:

1. Client gọi "tạo preview" → server **ghi ngay** một bản ghi trạng thái `generating` vào nơi lưu
   trữ (trước khi gọi LLM) → trả về bản ghi đó ngay lập tức (kèm `id`).
2. Server tiếp tục gọi LLM ở nền (không block response gốc).
3. Client mở tab preview ngay với trạng thái "đang tạo…", và **poll định kỳ** (vài giây/lần) để
   biết khi nào xong.
4. LLM trả lời xong → server ghi đè bản ghi: `status: done`, lưu nội dung HTML, cập nhật
   "dấu vân tay" (hash) nội dung note tại thời điểm tạo. Lỗi → `status: error` kèm thông báo.
5. **Reload trang giữa chừng**: vì trạng thái nằm trên đĩa (không chỉ trong bộ nhớ trình duyệt),
   client mở lại app sẽ hỏi lại server và tự khôi phục đúng: vẫn đang tạo (tiếp tục poll), đã xong
   (hiện kết quả), hoặc lỗi.
6. **Server khởi động lại giữa lúc đang generate** (tiến trình bị giết): khi server start, quét
   qua các bản ghi đang ở trạng thái `generating` và tự chuyển sang `error` ("bị gián đoạn do
   server khởi động lại, vui lòng thử lại") — tránh treo vĩnh viễn.

## 4. Nơi lưu trữ dữ liệu

**Cấu hình LLM (thuộc người dùng, không thuộc riêng vault)** — thêm nhóm mới vào file cấu hình
chung của app (cùng chỗ với cấu hình Git/API key hiện có):
- Provider đang chọn: Anthropic hoặc OpenAI.
- API key Anthropic, API key OpenAI — mỗi ô được che (`••••••••`) sau khi lưu, không bao giờ trả
  lại giá trị thật cho client, giống hệt cách token Git đang được xử lý hiện nay.
- Model OpenAI: ô nhập tự do, có giá trị mặc định sẵn — cho phép đổi mà không cần sửa code.
- Model Anthropic: dùng **alias phiên bản mới nhất của Claude Sonnet** (không cho chỉnh), tự động
  trỏ tới bản mới nhất mà không cần cập nhật code khi có model mới.
- Danh sách template: mỗi template gồm tên + nội dung prompt.

**Các bản preview đã tạo (thuộc riêng từng vault)** — lưu trong một **thư mục ẩn ngay trong vault**
(cùng cấp với thư mục thùng rác hiện có), theo đúng quy ước ẩn thư mục dot-prefix đã có sẵn trong
hệ thống (tự động không hiện trong cây thư mục, không bị index tìm kiếm/đồ thị liên kết/watcher
đụng tới — không cần code thêm gì đặc biệt ở 3 trong 4 chỗ đang lọc, chỉ cần thêm 1 dòng vào danh
sách loại trừ của bộ theo dõi thay đổi file). Mỗi bản ghi preview gồm: id, note nào, tên hiển thị,
prompt/template đã dùng, trạng thái (`generating`/`done`/`error`), thông báo lỗi (nếu có), thời điểm
tạo/cập nhật, và "dấu vân tay" nội dung note tại thời điểm tạo thành công gần nhất (dùng để tính
out-of-sync bằng cách so với dấu vân tay nội dung note hiện tại). Nội dung HTML thực tế lưu thành
file riêng cạnh bản ghi.

## 5. Luồng thao tác người dùng

1. Mở note → menu "⋯" → mục **"HTML Preview…"** (chỉ hiện với file `.md`).
2. Hộp thoại liệt kê các preview đã có của note: tên, trạng thái (đang tạo/lệch/lỗi/bình thường),
   nút **Đổi tên** và **Xoá** trên từng dòng. Bấm vào dòng (ngoài vùng nút) → mở tab preview đó.
3. Nút **"+ Tạo preview mới"**: chọn 1 template có sẵn (dropdown) **hoặc** gõ prompt tuỳ ý, có
   checkbox "Lưu thành template" (kèm ô đặt tên) khi gõ tuỳ ý. Bấm Generate → hộp thoại đóng, tab
   mới mở ngay với trạng thái "đang tạo…".
4. Trong tab preview: badge trạng thái ở đầu tab (đang tạo / lệch với note / lỗi kèm lý do) + nút
   **"Tạo lại"** (chạy lại đúng prompt cũ, cập nhật dấu vân tay). Nội dung HTML hiển thị trong
   khung cách ly — không thể đọc cookie đăng nhập hay dữ liệu khác của app (phòng trường hợp LLM
   sinh ra mã độc hại trong HTML).
5. Trong Settings có mục mới quản lý: cấu hình provider + API key, và danh sách template (thêm/sửa
   tên & nội dung/xoá).

## 6. Xử lý lỗi

- Chưa cấu hình API key cho provider đang chọn → báo lỗi ngay khi bấm Generate, dẫn người dùng tới
  Settings.
- LLM trả lỗi (hết hạn mức, sai key, lỗi mạng) → bản ghi chuyển `error` kèm thông báo (không lộ
  API key trong thông báo), tab preview hiện lỗi + nút thử lại.
- LLM trả về nội dung rỗng hoặc không phải HTML hợp lệ → coi là lỗi, cho thử lại.
- Note bị xoá trong lúc đang có preview liên kết → preview vẫn giữ được (không tự xoá theo), chỉ
  không tính được out-of-sync nếu note gốc không còn.

## 7. Kiểm thử trước khi bàn giao

Không có bộ test tự động trong dự án — theo đúng quy ước hiện tại, kiểm thử bằng tay như người
dùng thật, dùng API key thật do người dùng cung cấp:
- Tạo preview trên 1 note mẫu (cả Anthropic lẫn OpenAI), xác nhận HTML render đúng trong tab.
- Reload trang ngay khi đang "đang tạo" → xác nhận trạng thái được khôi phục đúng, poll tiếp tục.
- Sửa nội dung note sau khi đã có preview → xác nhận badge "lệch" xuất hiện; bấm "Tạo lại" → badge
  biến mất.
- Đổi tên / xoá preview trong hộp thoại quản lý.
- Thiếu API key → xác nhận thông báo lỗi rõ ràng, dẫn tới đúng chỗ trong Settings.
- Xác nhận thư mục ẩn chứa preview không xuất hiện trong cây thư mục, không bị index tìm kiếm bắt
  được, không kích hoạt watcher reload thừa.

## 8. Ghi chú đồng bộ tài liệu dự án

Theo quy ước của CLAUDE.md, khi bắt đầu triển khai plan cho spec này cần đồng thời:
- Thêm **FR mới** vào `PRD.md` (mục Yêu cầu chức năng) mô tả tính năng này, kèm dòng changelog.
- Thêm mục tương ứng vào `IMPLEMENTATION_PLAN.md` (checklist `[ ]` → `[~]` → `[x]`) và cập nhật
  "Nhật ký tiến độ".
