# Collapsible headings trong Reading view

**Ngày:** 2026-07-10
**Trạng thái:** Đã chốt thiết kế, sẵn sàng viết plan.

## Mục tiêu

Cho phép người dùng thu gọn (collapse) từng heading trong Reading view của note.
Khi thu gọn một heading, toàn bộ nội dung bên dưới nó — kể cả các heading con cấp
nhỏ hơn — bị ẩn cho tới heading cùng cấp hoặc cấp lớn hơn tiếp theo (đúng kiểu
Obsidian). Trạng thái collapsed được persist qua localStorage, theo từng note.

## Phạm vi

- **Chỉ Reading view** (`web/src/components/Preview.tsx`). Không đụng Live Preview
  (CM6) hay Source mode.
- **Tất cả heading H1–H6** trong nội dung chính của note đều foldable.
- **Loại trừ:** heading nằm trong callout (`> [!note]`) hoặc trong note nhúng
  (transclusion `![[note]]`) KHÔNG foldable — tránh rối logic lồng nhau. Cụ thể:
  chỉ các heading là con trực tiếp của container body chính (`bodyRef` >
  wrapper) mới được xử lý; heading nằm trong `.callout-content` / `.embed-note`
  bị bỏ qua.

## Kiến trúc

Pipeline hiện tại: `renderMarkdown()` (remark/rehype) → HTML string → set vào
`bodyRef` qua `dangerouslySetInnerHTML` → một `useEffect` post-render pass chạy
các renderer (KaTeX, mermaid, callout icon…).

Collapse được cài như **một bước post-render mới** trong `Preview.tsx`, chạy sau
khi HTML đã vào DOM. Lý do: heading và các sibling nằm phẳng trong DOM (không
lồng nhau theo section), nên gom "nội dung thuộc về heading" dễ nhất bằng cách
duyệt DOM sau render, không phải sửa pipeline markdown.

### Các đơn vị (module) mới

1. **`web/src/lib/headingFold.ts`** — logic thuần, không phụ thuộc React:
   - `computeHeadingKeys(headings)`: nhận danh sách heading (level + text theo
     thứ tự xuất hiện), trả về khóa breadcrumb cho từng heading (xem "Persist
     key"). Tách riêng để test được bằng unit test thuần.
   - `loadCollapsed(notePath)` / `saveCollapsed(notePath, keys)`: đọc/ghi
     localStorage.
   - Hằng số `STORAGE_KEY = 'webobsidian:heading-fold'`.

2. **`web/src/lib/headingFoldDom.ts`** (hoặc gộp vào `Preview.tsx` nếu nhỏ) —
   thao tác DOM:
   - `setupHeadingFold(root, notePath)`: quét các heading foldable, gán chevron,
     wire sự kiện click, áp trạng thái đã lưu, trả về `{ collapseAll, expandAll }`
     để view-header gọi. Idempotent (chạy lại mỗi lần re-render mà không nhân
     đôi chevron).

### Cách gom "nội dung thuộc heading"

Sau render, các phần tử con của body wrapper là một danh sách phẳng:
`h2, p, ul, h3, p, h2, …`. Với mỗi heading level L bị collapsed, ẩn mọi sibling
đứng sau nó cho tới khi gặp heading có level ≤ L (hoặc hết danh sách). Dùng
`element.hidden = true` (thuộc tính `hidden`, không xoá khỏi DOM) để dễ khôi phục
và không mất trạng thái các renderer async (KaTeX/mermaid) đã gắn.

Vì heading con lồng cũng bị ẩn khi heading cha collapsed, cần quyết định thứ tự
áp trạng thái: duyệt từ trên xuống; nếu một heading nằm trong vùng đã bị ẩn bởi
heading cha collapsed, chevron của nó vẫn giữ trạng thái riêng (để khi mở cha ra
thì con vẫn nhớ đã collapsed hay chưa), nhưng phần thân của nó lúc này đằng nào
cũng bị ẩn bởi cha.

## Persist key (breadcrumb)

Khóa của một heading = chuỗi breadcrumb: nối text của các heading tổ tiên (heading
cấp lớn hơn gần nhất phía trên, đệ quy lên) với chính nó, phân tách bằng ` > `.

Ví dụ cây:
```
# A
## B
### C
## B        <- trùng breadcrumb "A > B" với cái trên
```
- `A`
- `A > B`
- `A > B > C`
- `A > B` (trùng!) → thêm hậu tố `#2` → `A > B#2`

Số thứ tự chỉ được thêm khi breadcrumb trùng KHÍT (tính theo lần xuất hiện thứ n
của cùng một breadcrumb). Điều này giữ khóa ổn định khi thêm/xoá heading ở nhánh
khác của cây.

**Trade-off đã chấp nhận:** đổi tên chính heading đó hoặc một tổ tiên trực tiếp
của nó → khóa đổi → mất trạng thái collapsed cho heading đó (coi như heading mới).
Đây là lựa chọn người dùng đã đồng ý.

**Lưu trữ:** một object trong localStorage dạng
`{ [notePath]: string[] }` — mảng các khóa đang collapsed cho mỗi note. Khoá rỗng
thì xoá entry để không phình localStorage.

## Giao diện (CSS)

- Chevron đặt bên trái heading, cùng pattern SVG với `.callout-fold` hiện có.
- Mặc định `opacity: 0`; khi `:hover` lên dòng heading thì `opacity: 1`.
- Khi heading đang collapsed, chevron xoay -90° (giống `.callout.is-collapsed
  .callout-fold`), và luôn hiện (opacity 1) để báo trạng thái dù không hover.
- Trên thiết bị cảm ứng (`@media (hover: none)` hoặc `(pointer: coarse)`):
  chevron luôn hiện vì không có hover.
- Class trạng thái: heading collapsed nhận class `is-collapsed`. Sibling bị ẩn
  dùng thuộc tính `hidden` (không cần class riêng).

## Nút Collapse all / Expand all

- Thêm 2 mục vào menu "More options" (dấu ba chấm) trong `view-header`
  (`Workspace.tsx`), chỉ hiện khi `viewMode === 'reading'` và note là markdown.
- `setupHeadingFold` expose `collapseAll` / `expandAll`; Preview lưu 2 hàm này
  vào store (hoặc ref chia sẻ) để menu gọi được. Dùng một ô nhỏ trong store
  Zustand: `headingFoldControls: { collapseAll, expandAll } | null`.

## Luồng dữ liệu

1. Note đổi / view chuyển sang reading → `Preview` render HTML.
2. Post-render `useEffect` gọi `setupHeadingFold(root, activePath)`:
   - Quét heading foldable, tính breadcrumb keys.
   - Đọc `loadCollapsed(activePath)`, áp `hidden` cho vùng tương ứng, set class
     `is-collapsed`.
   - Gắn chevron + click handler; click → toggle → cập nhật DOM +
     `saveCollapsed`.
   - Đăng ký `collapseAll`/`expandAll` vào store.
3. Rời note / unmount → cleanup: gỡ đăng ký store.

## Xử lý lỗi / edge case

- **localStorage không khả dụng** (private mode, quota): bọc read/write trong
  try/catch, thất bại thì fold vẫn hoạt động trong phiên nhưng không persist.
- **Note không có heading:** không làm gì, menu collapse-all vẫn hiện nhưng
  no-op (hoặc ẩn — quyết định khi code: ẩn nếu không có heading foldable).
- **Heading trùng breadcrump khít:** xử lý bằng hậu tố `#n` như trên.
- **Re-render (đổi nội dung, KaTeX gắn xong):** `setupHeadingFold` idempotent —
  kiểm tra chevron đã tồn tại thì bỏ qua, đọc lại trạng thái từ storage.

## Testing

- **Unit (Vitest — cần thêm devDep vào `web/`):** `computeHeadingKeys` với các
  cây heading (lồng nhau, trùng text, trùng breadcrumb) → đúng khóa + hậu tố.
- **Manual E2E (như user thật):** mở note "Tây Nguyên" ở Reading view, collapse
  "Ngày 3" → nội dung tới trước "Ngày 4" bị ẩn; reload trang → vẫn collapsed;
  collapse all → mọi heading gọn; expand all → mở hết; kiểm tra mobile width
  chevron luôn hiện.

## Files thay đổi (dự kiến)

- `web/src/lib/headingFold.ts` (mới) — logic key + storage.
- `web/src/components/Preview.tsx` — post-render pass gọi setup; đăng ký store.
- `web/src/components/Workspace.tsx` — 2 mục menu More options (reading only).
- `web/src/lib/store.ts` — ô `headingFoldControls`.
- `web/src/styles/obsidian.css` — style chevron + hover + touch.
- (Optional) `web/vitest.config.ts` + devDep vitest cho unit test key.
