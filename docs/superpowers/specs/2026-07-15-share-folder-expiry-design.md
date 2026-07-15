# Design: Share thư mục + Share có thời hạn

Ngày: 2026-07-15
Liên quan: PRD.md FR-10 (Deep-link URL & Public share)

## Bối cảnh

Tính năng share hiện tại (`server/src/services/shares.ts`, `server/src/routes/shares.ts`,
`server/src/routes/sharepage.ts`, `web/src/components/ShareDialog.tsx`) chỉ hỗ trợ:
- Share 1 note `.md`/`.markdown` hoặc 1 `.canvas` (không phải thư mục).
- Không có thời hạn (TTL) cho share link — chỉ có `enabled` bật/tắt thủ công và password tuỳ chọn.

Yêu cầu mới: (1) share cả thư mục (đọc dạng cây, giống trải nghiệm xem trong app), (2) share có
thời hạn với các mốc thời gian dựng sẵn.

Các quyết định UX đã chốt với người dùng:
- Share thư mục hiển thị dạng cây file browser read-only (không phải danh sách tải file rời hay zip).
- File không phải note (ảnh, PDF, video...) trong cây hiển thị giống trải nghiệm xem bình thường
  trong app: preview trực tiếp nếu là ảnh/video/audio, còn lại cho tải về.
- Trang share thư mục dựng bằng server-render (SSR), điều hướng bằng load trang mới — giữ đúng
  triết lý "không cần JS để đọc nội dung" của FR-10, không biến thành single-page app.
- 4 mốc thời hạn dựng sẵn: **1 ngày / 7 ngày / 30 ngày / Không giới hạn**.
- Link hết hạn → trang "Link đã hết hạn" riêng biệt, không lộ tên file/thư mục.

## Data model

`ShareRecord` (`server/src/services/shares.ts`) thêm 2 field:

```ts
export interface ShareRecord {
  id: string;
  path: string;
  kind: 'file' | 'folder';     // MỚI — mặc định 'file' khi đọc record cũ không có field này
  enabled: boolean;
  createdAt: string;
  expiresAt?: string | null;   // MỚI — ISO timestamp; null/undefined = không giới hạn
  passwordHash?: string;
}
```

- Record cũ trong `data/shares.json` không có `kind` → khi load, coi như `'file'` (migrate on read,
  không cần script migrate riêng vì đây là JSON phẳng tự quản lý).
- 1 record cho mỗi path (file hoặc folder) — giữ nguyên quy tắc "tạo lại trên path đã share →
  trả về record cũ, bật lại `enabled`" như hiện tại, áp dụng cho cả hai kind.
- Không giới hạn số lượng share lồng nhau (1 thư mục cha được share và 1 file con trong đó cũng
  có share riêng) — hai record độc lập, không cần xử lý đặc biệt.

## Service layer (`shares.ts`)

- `isShareable(path, kind)`: nếu `kind === 'file'` giữ nguyên check đuôi `.md`/`.markdown`/`.canvas`;
  nếu `kind === 'folder'` check path tồn tại và là thư mục (dùng helper tương đương
  `vault.exists`/`fs.stat`, không share được root vault rỗng hoặc path không tồn tại).
- `createShare(path, kind)`: thêm tham số `kind`, lưu vào record mới; tìm record cũ theo cả
  `path` lẫn `kind` khớp (đề phòng path trùng tên giữa file và folder — dù hiếm, giữ đúng ngữ nghĩa).
- Thêm `getShareStatus(id): { status: 'active'; record: ShareRecord } | { status: 'expired' } | { status: 'not_found' }`
  — hàm trung tâm duy nhất mọi route public/SSR dùng để lấy trạng thái share, thay cho
  `getActiveShare()` hiện tại. Logic hết hạn: `record.expiresAt` có giá trị và
  `Date.now() > new Date(record.expiresAt).getTime()` → `'expired'`. `enabled === false` hoặc
  không tìm thấy record → `'not_found'` (không phân biệt disabled vs không tồn tại, giữ đúng
  hành vi bảo mật hiện tại — không lộ thông tin).
- Các route hiện dùng `getActiveShare()` chuyển sang gọi `getShareStatus()` và tự quyết định
  render gì theo status (xem phần Routes).

## Routes công khai (`server/src/routes/shares.ts`, `sharepage.ts`)

**Trang SSR chính `GET /share/:id`:**
- `status === 'not_found'` → 404 như hiện tại.
- `status === 'expired'` → render trang "Link đã hết hạn" (HTML tĩnh, `noindex`, không có tên
  file/thư mục, không có nội dung).
- `status === 'active'`, `kind === 'file'` → giữ nguyên hành vi hiện tại (render nội dung note/canvas).
- `status === 'active'`, `kind === 'folder'` → render trang liệt kê cây thư mục ở gốc share
  (breadcrumb chỉ có tên thư mục gốc, danh sách entry con: thư mục trước, file sau, sắp xếp
  alphabet).

**Route mới `GET /share/:id/f/*subpath`** (chỉ áp dụng khi `kind === 'folder'`):
- Guard hết hạn/not-found giống route gốc.
- Resolve `subpath` tương đối so với `record.path` bằng cơ chế chống path-traversal đã có
  (`vault.resolveInVault`, cùng cơ chế đang chặn `../` và symlink cho file nhúng hiện tại) —
  nếu resolve ra ngoài phạm vi thư mục gốc của share → 404.
- Nếu target là thư mục → render trang liệt kê (breadcrumb đầy đủ từ gốc share tới đây, danh
  sách entry con).
- Nếu target là file:
  - `.md`/`.markdown`/`.canvas` → render bằng đúng pipeline render note/canvas đang dùng cho
    file-kind share (markdown → sanitize HTML, hoặc canvas SSR snapshot).
  - Ảnh/video/audio (theo danh sách đuôi file đã dùng để nhận diện embed hiện tại) → trang có
    khung xem trực tiếp (thẻ `<img>`/`<video>`/`<audio>`), trỏ `src` vào endpoint serve file bên dưới.
  - Loại khác → trang nhỏ hiện tên file + nút "Tải về" trỏ vào endpoint serve file bên dưới.
- Có password → áp dụng `isUnlocked()` y hệt route gốc trước khi render bất kỳ nội dung nào
  (kể cả breadcrumb/tên file, để không lộ cấu trúc thư mục khi chưa unlock).

**Endpoint serve file nhị phân `GET /public/shares/:id/file?path=`:**
- Với `kind === 'file'` (share note đơn): giữ nguyên allowlist hiện tại — chỉ phục vụ đúng các
  file được note đó `![[...]]`/`![](...)` nhúng. Không đổi hành vi bảo mật hiện có.
- Với `kind === 'folder'`: allowlist mở rộng thành "mọi file resolve được bên trong phạm vi
  `record.path`" (vẫn qua `resolveInVault` để chặn traversal) — vì cả thư mục đã được chủ động
  chia sẻ, không cần giới hạn theo embed target như trường hợp 1 note.
- Vẫn không serve `.md`/`.markdown`/`.canvas` qua endpoint này (những file đó render qua route
  `/f/*subpath` ở trên, không phải qua endpoint file nhị phân).

## API quản lý (`POST/PATCH /api/shares`, cần auth)

- `POST /api/shares` nhận thêm `kind` trong body (`'file' | 'folder'`, mặc định `'file'` nếu
  không gửi — giữ tương thích client cũ trong lúc chuyển đổi, dù thực tế web app sẽ luôn gửi
  field này sau khi cập nhật).
- `PATCH /api/shares/:id` nhận thêm `expiresAt?: string | null` bên cạnh `enabled?`/`password?`
  hiện có. Client tính sẵn timestamp tuyệt đối (now + N ngày) rồi gửi lên — server không cần biết
  khái niệm "mốc thời gian dựng sẵn", chỉ lưu thời điểm hết hạn tuyệt đối. Gửi `null` để gỡ hạn
  (chuyển về không giới hạn).

## UI (`web/`)

- **Context menu thư mục** (file tree): thêm mục "Share…" giống file, mở `ShareDialog` với
  path thư mục + `kind: 'folder'`.
- **`ShareDialog.tsx`**: thêm 4 nút mốc thời hạn (1 ngày / 7 ngày / 30 ngày / Không giới hạn).
  Bấm nút → gọi PATCH với `expiresAt` tính từ thời điểm hiện tại (hoặc `null`). Hiển thị hạn
  hiện tại của share dưới dạng ngày cụ thể (hoặc "Không giới hạn" nếu chưa đặt).
- **Badge file tree**: icon globe hiện tại cho note đang share — mở rộng áp dụng tương tự cho
  thư mục đang share (badge trên tên thư mục).
- Store (`web/src/lib/store.ts`) và API client (`web/src/lib/api.ts`) cập nhật type `ShareRecord`
  phía client thêm `kind`/`expiresAt`, hàm `setShareExpiry(id, expiresAt)`.

## Bảo mật — điểm cần giữ đúng

- Toàn bộ resolve path cho cả folder listing lẫn file-serving đều phải đi qua cơ chế chống
  path-traversal đã có (`vault.resolveInVault`), không tự viết lại logic ghép chuỗi path.
- Trang "hết hạn" và trang "không tồn tại" phải giống hệt nhau về việc **không lộ** tên
  file/thư mục — chỉ khác nội dung thông báo hiển thị cho người dùng.
- Cookie unlock (JWT, `isUnlocked()`) tái dùng nguyên trạng — không đổi cơ chế ký/verify hiện có,
  chỉ áp dụng check này ở nhiều route hơn (route `/f/*subpath` mới).
- Không log nội dung path thư mục/note nhạy cảm ra console theo đúng quy ước bảo mật của project
  (CLAUDE.md: không log secret/token, nhưng path thư mục thông thường không phải secret — vẫn
  tránh log dư thừa không cần thiết).

## Testing

- Unit (Vitest, `server/`): `getShareStatus()` với các case active/expired/not_found/disabled;
  `createShare` với `kind: 'folder'`; allowlist file-serving cho folder-kind không cho traversal
  ra ngoài `record.path`.
- Integration: tạo folder share qua API, gọi `GET /share/:id` và `GET /share/:id/f/<subpath>`
  không auth, xác nhận cây hiển thị đúng, file nhị phân bên trong serve được, note con render
  đúng nội dung; thử `subpath` chứa `../` bị chặn.
- E2E thủ công (bắt buộc theo quy ước cá nhân): chạy `npm run dev`, tạo 1 folder share thật qua
  UI, mở link ở tab ẩn danh, duyệt qua vài cấp thư mục, mở 1 note và 1 ảnh trong đó, đặt hạn
  1 ngày và xác nhận UI hiển thị đúng ngày hết hạn.

## Ngoài phạm vi (v1)

- Không cho phép "gia hạn tự động" hay thông báo trước khi hết hạn.
- Không hỗ trợ zip toàn bộ thư mục để tải 1 lần.
- Không đổi cơ chế password/unlock cookie hiện có (TTL 12h giữ nguyên, không liên quan tới
  `expiresAt` của share record).
