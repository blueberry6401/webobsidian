# Outline navigation: click-to-jump + scroll-spy

**Ngày:** 2026-07-11
**Trạng thái:** Thiết kế (chờ triển khai).

## Mục tiêu

Biến panel **Outline** (sidebar phải) từ danh sách heading tĩnh thành thanh điều
hướng giống outline bên trái của Google Docs:

1. **Click-to-jump** — bấm vào một heading trong Outline → editor cuộn tới đúng
   heading đó. Nếu đang ở Reading và heading đích nằm trong một section đã bị thu
   gọn (collapsed), tự động mở các ancestor liên quan trước khi cuộn.
2. **Scroll-spy** — khi người dùng cuộn note, Outline tự tô sáng mục ứng với
   heading đang xem (heading gần nhất phía trên mốc ~40px dưới đỉnh viewport).

Áp dụng cho **cả Reading và Editing** (live/source), trên khung soạn thảo chính.

## Bối cảnh kiến trúc (quan trọng)

- **Reading view KHÔNG phải `Preview.tsx`.** `Workspace.tsx > EditorPane` luôn
  render `<Editor />` (CodeMirror Live Preview); "Reading" chỉ là chế độ read-only
  của editor đó (`livePreviewReadonly`). `Preview.tsx` chỉ dùng cho split-pane
  (desktop) và mobile embed. → Logic cuộn/scroll-spy phải chạy trên **CodeMirror**
  (`web/src/lib/livePreview.ts` + `Editor.tsx`), không phải remark/rehype.
- Đã có sẵn handle editor toàn cục: `activeEditor.ts` (`getActiveEditor()`),
  Editor đăng ký/xoá `setActiveEditor` khi mount/unmount.
- Đã có sẵn hạ tầng thu-gọn-heading trong CM (merge từ main):
  - `livePreview.ts`: `scanDocHeadings(doc)` (bỏ qua fenced code), `notePathField`,
    `headingFoldRefresh` effect, `headingFoldDeco` StateField.
  - `headingFold.ts`: `computeHeadingKeys`, `loadCollapsed`, `saveCollapsed`
    (keyed theo breadcrumb, persist localStorage per note).
- Outline panel: `RightSidebar.tsx > OutlinePanel` gọi `outline(content)` từ
  `web/src/lib/markdown.ts`.

## Vấn đề cần khắc phục trước: hai bộ quét heading lệch nhau

- `markdown.ts` → `outline(src)`: quét regex `^#{1,6}\s+…` trên **mọi dòng**,
  KHÔNG bỏ qua fenced code block. → Một dòng `# not a heading` trong ` ``` ` sẽ
  lọt vào Outline.
- `livePreview.ts` → `scanDocHeadings(doc)`: bỏ qua fenced code, và là nguồn sự
  thật cho fold + (sẽ là) jump target.

Nếu Outline dùng chỉ số `i` để map sang heading thứ `i` của editor, hai danh sách
**phải khớp thứ tự và số lượng**, nếu không click sẽ nhảy sai chỗ. → Thống nhất
một bộ quét: `OutlinePanel` dùng cùng logic "bỏ qua fenced code" như
`scanDocHeadings`.

**Cách làm:** nâng cấp `outline(src)` trong `markdown.ts` để bỏ qua fenced code
(``` / ~~~), trả về `{ level, text }[]` như cũ (giữ chữ ký, không phá consumer
khác). `scanDocHeadings` tiếp tục sống trong `livePreview.ts` (nó cần `lineFrom`/
`lineNo`); hai hàm phải cho ra **cùng chuỗi heading**. Thêm test đảm bảo bất biến
này (cùng input → cùng danh sách `{level,text}`).

## Thiết kế

### A. API điều hướng trên editor — `web/src/lib/outlineNav.ts` (mới)

Một module nhỏ, không phụ thuộc React, đóng vai trò cầu nối Outline ↔ CodeMirror.
Dùng `getActiveEditor()` để lấy `EditorView` hiện hành.

```ts
/** Cuộn editor tới heading thứ index (theo scanDocHeadings). Reading: mở ancestor
 *  đang collapsed nếu cần trước khi cuộn. Trả về false nếu không có editor/heading. */
export function jumpToHeading(index: number): boolean;

/** Chỉ số heading đang "đang xem" theo vị trí cuộn hiện tại (heading gần nhất phía
 *  trên mốc topMargin px dưới đỉnh viewport), hoặc -1 nếu chưa có/không xác định. */
export function activeHeadingIndex(view: EditorView, topMargin?: number): number;
```

**`jumpToHeading(index)`** — các bước:
1. `view = getActiveEditor()`; nếu null → false.
2. `heads = scanDocHeadings(view.state.doc)`; nếu `index` ngoài phạm vi → false.
3. Nếu đang ở Reading (`view.state.field(livePreviewReadonly)`), heading đích có
   thể bị ẩn trong section collapsed của ancestor. Tính breadcrumb keys
   (`computeHeadingKeys`) và **bỏ collapsed cho mọi ancestor** của heading đích
   (ancestor = heading trước đó có `level < target.level`, truy ngược bằng stack),
   `saveCollapsed(np, set)` rồi `dispatch({ effects: headingFoldRefresh.of(null) })`
   để deco rebuild (heading đích lộ ra). Chỉ đụng ancestor keys — giữ nguyên trạng
   thái collapsed của các section khác.
4. `dispatch({ selection: { anchor: head.lineFrom }, effects:
   EditorView.scrollIntoView(head.lineFrom, { y: 'start', yMargin: 8 }) })`.
   Reading là read-only nên đặt selection không gây hại; nếu read-only chặn
   selection, fallback chỉ dùng `scrollIntoView`.
5. Không `view.focus()` khi Reading (tránh caret nhấp nháy); ở Editing thì focus
   để người dùng gõ tiếp được.

**`activeHeadingIndex(view, topMargin=40)`** — heading gần nhất mà toạ độ block của
nó ≤ (đỉnh viewport + topMargin). Dùng `view.lineBlockAt(head.lineFrom).top` so
với `view.scrollDOM.scrollTop`. Trả về index lớn nhất thoả điều kiện; nếu chưa
cuộn qua heading nào → 0 (heading đầu) khi có heading, ngược lại -1.

### B. Scroll-spy: phát tín hiệu heading đang xem

Outline cần biết index đang active để tô sáng. Dùng singleton observer giống
`headingFoldControls.ts`:

`web/src/lib/outlineActive.ts` (mới) — một store cực nhỏ:
```ts
let current = -1;
const subs = new Set<(i: number) => void>();
export function setActiveHeading(i: number): void; // no-op nếu trùng
export function getActiveHeading(): number;
export function subscribeActiveHeading(fn): () => void;
```

Trong `Editor.tsx`, thêm vào cấu hình CM một `EditorView.updateListener` (hoặc mở
rộng handler `scroll` đã có) tính `activeHeadingIndex(view)` khi `geometryChanged`/
scroll và gọi `setActiveHeading(i)` (throttle ~100ms bằng rAF/timer, tái dùng
`scrollSaveTimer` pattern). Khi editor unmount/đổi note → reset về -1.

### C. `OutlinePanel` (RightSidebar.tsx) — click + highlight

- Danh sách heading lấy từ `outline(content)` (đã đồng bộ bộ quét ở phần trên).
- Mỗi `.outline-item`:
  - `onClick={() => jumpToHeading(i)}`
  - `className` thêm `is-active` khi `i === active` (từ `subscribeActiveHeading`
    qua một `useSyncExternalStore`/`useEffect+useState`).
  - Mục active tự cuộn vào tầm nhìn trong panel (`scrollIntoView({ block: 'nearest' })`)
    khi note dài.
- Con trỏ chuột `cursor: pointer` (đã có trong CSS `.outline-item`).

### D. CSS — `web/src/styles/obsidian.css`

Thêm trạng thái active cho outline item (giống Google Docs: thanh accent trái +
chữ đậm hơn):
```css
.outline-item.is-active {
  color: var(--text-normal);
  background: var(--bg-modifier-hover);
  box-shadow: inset 2px 0 0 var(--interactive-accent);
}
```

## Phạm vi & loại trừ

- **Chỉ khung editor chính** (nguồn của Outline panel). Không đụng split-pane
  `Preview.tsx` / mobile embed.
- Không thêm sticky header nổi (đã loại ở brainstorming — chỉ nâng cấp Outline).
- Không thay đổi hành vi fold hiện có; jump chỉ *mở thêm* ancestor khi cần, không
  tự thu gọn gì.
- Heading trong callout/embed: `scanDocHeadings` không quét chúng (chỉ ATX ở cấp
  document, và fenced code bị bỏ qua) → Outline vốn đã không liệt kê chúng; giữ
  nguyên.

## Data flow

```
content (store) ──> outline() ──> OutlinePanel render danh sách
       │                                   │ click(i)
       │                                   ▼
       │                         jumpToHeading(i) ──> getActiveEditor()
       │                                   │            ├─ (reading) mở ancestor collapsed
       │                                   │            └─ scrollIntoView(lineFrom)
       ▼
Editor scroll ──> activeHeadingIndex() ──> setActiveHeading(i)
                                               │ subscribe
                                               ▼
                                   OutlinePanel tô .is-active
```

## Kiểm thử

- **Vitest (thuần logic):**
  - `outline()` bỏ qua heading trong fenced code; khớp `scanDocHeadings` (cùng
    `{level,text}` cho cùng input).
  - `activeHeadingIndex`: với danh sách top offsets giả lập (inject `lineBlockAt`
    stub), trả về đúng index theo scrollTop + topMargin (biên: trên heading đầu →
    0; cuộn qua vài heading → heading trước mốc).
  - Logic "mở ancestor" cho heading đích: cho một cây heading + tập collapsed,
    hàm tính đúng tập keys ancestor cần xoá.
- **E2E thủ công (real app, theo yêu cầu người dùng):** mở note nhiều heading
  (dùng đúng file trip trong ảnh), Reading + Editing: click từng ngày → cuộn
  đúng; cuộn tay → mục sáng theo; click heading nằm trong section đã collapse →
  tự mở + cuộn tới.

## Rủi ro / lưu ý

- **Đồng bộ index** là điểm dễ vỡ nhất: nếu `outline()` và `scanDocHeadings` lệch
  một heading, mọi click lệch theo. Test bất biến bắt buộc.
- **Scroll-spy hiệu năng:** throttle bằng rAF; `scanDocHeadings` chạy mỗi lần
  tính active có thể tốn với note rất lớn → cache theo `doc` (chỉ rescan khi
  `docChanged`).
- Không persist gì mới vào Zustand (active index là ephemeral, giống fold
  controls singleton).
