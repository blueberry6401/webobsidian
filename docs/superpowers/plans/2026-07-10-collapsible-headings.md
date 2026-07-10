# Collapsible Headings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cho phép thu gọn từng heading (H1–H6) trong Reading view; nội dung dưới heading bị ẩn tới heading cùng/cao cấp tiếp theo; trạng thái persist qua localStorage theo note; kèm Collapse all / Expand all.

**Architecture:** Logic thuần (tính khóa breadcrumb + đọc/ghi localStorage) tách ra `web/src/lib/headingFold.ts` (test bằng Vitest). Thao tác DOM (quét heading, gắn chevron, ẩn/hiện sibling) đặt trong `web/src/lib/headingFoldDom.ts`, gọi từ post-render `useEffect` của `Preview.tsx`. Controls collapse-all/expand-all chia sẻ với menu qua module singleton `web/src/lib/headingFoldControls.ts` (không đụng Zustand persist).

**Tech Stack:** React, TypeScript, Zustand, Vite. Vitest (thêm mới, chỉ cho unit test logic thuần).

## Global Constraints

- Ngôn ngữ: TypeScript, tránh `any` khi có thể (theo CLAUDE.md).
- Chỉ áp dụng Reading view (`Preview.tsx`); KHÔNG đụng Live Preview/Source (CM6).
- Heading trong `.callout-content` và `.embed-note` KHÔNG foldable.
- localStorage key gốc: `webobsidian:heading-fold`. Value: `{ [notePath]: string[] }`.
- Mọi truy cập localStorage bọc try/catch (private mode/quota không được crash).
- Không log secret/token (không liên quan ở đây nhưng giữ nguyên tắc).

---

### Task 1: Logic thuần — tính khóa breadcrumb + storage (`headingFold.ts`)

**Files:**
- Create: `web/src/lib/headingFold.ts`
- Create: `web/src/lib/headingFold.test.ts`
- Create: `web/vitest.config.ts`
- Modify: `web/package.json` (thêm devDep `vitest` + script `test`)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface HeadingInfo { level: number; text: string }`
  - `computeHeadingKeys(headings: HeadingInfo[]): string[]` — trả về mảng khóa
    breadcrumb, cùng chỉ số với input.
  - `loadCollapsed(notePath: string): Set<string>`
  - `saveCollapsed(notePath: string, keys: Set<string>): void`
  - `const STORAGE_KEY = 'webobsidian:heading-fold'`

- [ ] **Step 1: Thêm Vitest vào workspace web**

Modify `web/package.json` — trong `"scripts"` thêm dòng `"test": "vitest run"`, và
trong `"devDependencies"` thêm `"vitest": "^2.1.9"` (giữ nguyên các entry khác).
Sau đó cài:

```bash
cd web && npm install
```
Expected: `vitest` xuất hiện trong `web/node_modules/.bin/`.

- [ ] **Step 2: Tạo `web/vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Viết test thất bại `web/src/lib/headingFold.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { computeHeadingKeys, type HeadingInfo } from './headingFold';

const h = (level: number, text: string): HeadingInfo => ({ level, text });

describe('computeHeadingKeys', () => {
  it('builds breadcrumb from ancestors by level', () => {
    const keys = computeHeadingKeys([h(1, 'A'), h(2, 'B'), h(3, 'C')]);
    expect(keys).toEqual(['A', 'A > B', 'A > B > C']);
  });

  it('resets ancestors when a higher-or-equal level appears', () => {
    const keys = computeHeadingKeys([h(2, 'X'), h(3, 'Y'), h(2, 'Z')]);
    expect(keys).toEqual(['X', 'X > Y', 'Z']);
  });

  it('suffixes duplicate breadcrumbs with #n by occurrence order', () => {
    const keys = computeHeadingKeys([
      h(1, 'A'), h(2, 'B'), h(1, 'A'), h(2, 'B'),
    ]);
    expect(keys).toEqual(['A', 'A > B', 'A#2', 'A#2 > B']);
  });

  it('handles a heading that skips levels (h1 then h4)', () => {
    const keys = computeHeadingKeys([h(1, 'A'), h(4, 'D')]);
    expect(keys).toEqual(['A', 'A > D']);
  });
});
```

- [ ] **Step 4: Chạy test để xác nhận FAIL**

Run: `cd web && npx vitest run src/lib/headingFold.test.ts`
Expected: FAIL — `computeHeadingKeys` không tồn tại (module chưa có).

- [ ] **Step 5: Viết `web/src/lib/headingFold.ts`**

```ts
export interface HeadingInfo {
  level: number;
  text: string;
}

export const STORAGE_KEY = 'webobsidian:heading-fold';

/**
 * Với mỗi heading, dựng khóa breadcrumb = text các tổ tiên (heading cấp lớn hơn
 * gần nhất, đệ quy lên) nối bằng ' > '. Nếu hai heading cho ra breadcrumb trùng
 * khít, thêm hậu tố '#n' theo thứ tự xuất hiện để phân biệt.
 */
export function computeHeadingKeys(headings: HeadingInfo[]): string[] {
  const keys: string[] = [];
  const seen = new Map<string, number>();
  // Stack các tổ tiên hiện hành: mỗi phần tử { level, text }.
  const stack: HeadingInfo[] = [];
  for (const hd of headings) {
    // Pop các mục cùng cấp hoặc cấp nhỏ hơn (level >=) khỏi stack.
    while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
    const crumb = [...stack.map((s) => s.text), hd.text].join(' > ');
    const n = (seen.get(crumb) ?? 0) + 1;
    seen.set(crumb, n);
    keys.push(n === 1 ? crumb : suffix(crumb, n));
    stack.push(hd);
  }
  return keys;
}

// 'A > B' + 2 → 'A#2 > B' KHÔNG đúng — hậu tố phải gắn vào toàn khóa để duy nhất.
// Đơn giản: gắn '#n' vào cuối toàn breadcrumb.
function suffix(crumb: string, n: number): string {
  return `${crumb}#${n}`;
}

function readAll(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function loadCollapsed(notePath: string): Set<string> {
  const all = readAll();
  return new Set(all[notePath] ?? []);
}

export function saveCollapsed(notePath: string, keys: Set<string>): void {
  try {
    const all = readAll();
    if (keys.size === 0) delete all[notePath];
    else all[notePath] = [...keys];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage unavailable (private mode/quota) — fold works in-session only */
  }
}
```

**Lưu ý về test case trùng breadcrumb:** test Step 3 kỳ vọng `'A#2'` và
`'A#2 > B'`. Nhưng hàm trên tính breadcrumb con `'A > B'` từ text stack (`A`),
KHÔNG kế thừa hậu tố của cha → sẽ cho `'A > B'` lần 2, rồi vì trùng với `'A > B'`
lần 1 nên thành `'A > B#2'`, không phải `'A#2 > B'`. Điều chỉnh: stack phải lưu
**text đã định danh** (đã kèm hậu tố nếu cha bị trùng). Sửa vòng lặp:

```ts
export function computeHeadingKeys(headings: HeadingInfo[]): string[] {
  const keys: string[] = [];
  const seen = new Map<string, number>();
  const stack: { level: number; label: string }[] = [];
  for (const hd of headings) {
    while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
    const baseCrumb = [...stack.map((s) => s.label), hd.text].join(' > ');
    const n = (seen.get(baseCrumb) ?? 0) + 1;
    seen.set(baseCrumb, n);
    const key = n === 1 ? baseCrumb : `${baseCrumb}#${n}`;
    keys.push(key);
    // Label của heading này (dùng làm tiền tố cho con) = text + hậu tố nếu trùng.
    const label = n === 1 ? hd.text : `${hd.text}#${n}`;
    stack.push({ level: hd.level, label });
  }
  return keys;
}
```

Xoá hàm `suffix` không dùng. Với cây `A/B/A/B`: heading[2] `A` lần 2 →
baseCrumb `'A'` trùng → key `'A#2'`, label `'A#2'`; heading[3] `B` →
baseCrumb `'A#2 > B'` (mới, n=1) → key `'A#2 > B'`. Khớp test.

- [ ] **Step 6: Chạy test để xác nhận PASS**

Run: `cd web && npx vitest run src/lib/headingFold.test.ts`
Expected: PASS — cả 4 test.

- [ ] **Step 7: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: không lỗi liên quan tới file mới.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/headingFold.ts web/src/lib/headingFold.test.ts web/vitest.config.ts web/package.json web/package-lock.json
git commit -m "feat(reading): heading fold key + storage logic with tests"
```

---

### Task 2: DOM setup — quét heading, chevron, fold/unfold (`headingFoldDom.ts`)

**Files:**
- Create: `web/src/lib/headingFoldDom.ts`
- Create: `web/src/lib/headingFoldControls.ts`

**Interfaces:**
- Consumes (from Task 1): `computeHeadingKeys`, `loadCollapsed`, `saveCollapsed`, `HeadingInfo`.
- Produces:
  - `web/src/lib/headingFoldControls.ts`:
    - `type FoldControls = { collapseAll: () => void; expandAll: () => void } | null`
    - `setFoldControls(c: FoldControls): void`
    - `getFoldControls(): FoldControls`
  - `web/src/lib/headingFoldDom.ts`:
    - `setupHeadingFold(root: HTMLElement, notePath: string | null): void`
      — idempotent; quét heading foldable trong `root`, gắn chevron + click,
      áp trạng thái đã lưu, đăng ký controls collapse-all/expand-all.

- [ ] **Step 1: Tạo `web/src/lib/headingFoldControls.ts`**

```ts
// Singleton chia sẻ 2 hàm collapse-all/expand-all giữa Preview (owner) và
// menu More options (consumer). Tránh nhét vào Zustand persist state.
export type FoldControls = { collapseAll: () => void; expandAll: () => void } | null;

let controls: FoldControls = null;

export function setFoldControls(c: FoldControls): void {
  controls = c;
}

export function getFoldControls(): FoldControls {
  return controls;
}
```

- [ ] **Step 2: Tạo `web/src/lib/headingFoldDom.ts`**

```ts
import { computeHeadingKeys, loadCollapsed, saveCollapsed, type HeadingInfo } from './headingFold';
import { setFoldControls } from './headingFoldControls';

const CHEVRON_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';

const HEADING_SEL = 'h1, h2, h3, h4, h5, h6';

/** Chỉ nhận heading là hậu duệ của body chính, KHÔNG nằm trong callout/embed. */
function foldableHeadings(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(HEADING_SEL)].filter(
    (el) => !el.closest('.callout-content') && !el.closest('.embed-note'),
  );
}

const levelOf = (el: HTMLElement): number => Number(el.tagName[1]);

/** Các sibling từ ngay sau heading tới trước heading kế cùng/cao cấp hơn. */
function sectionSiblings(heading: HTMLElement, headings: HTMLElement[], idx: number): HTMLElement[] {
  const level = levelOf(heading);
  const out: HTMLElement[] = [];
  let node = heading.nextElementSibling as HTMLElement | null;
  const stopAt = headings.find((h, i) => i > idx && levelOf(h) <= level) ?? null;
  while (node && node !== stopAt) {
    out.push(node);
    node = node.nextElementSibling as HTMLElement | null;
  }
  return out;
}

export function setupHeadingFold(root: HTMLElement, notePath: string | null): void {
  const headings = foldableHeadings(root);
  if (headings.length === 0) {
    setFoldControls(null);
    return;
  }
  const infos: HeadingInfo[] = headings.map((h) => ({
    level: levelOf(h),
    text: (h.textContent ?? '').trim(),
  }));
  const keys = computeHeadingKeys(infos);
  const collapsed = notePath ? loadCollapsed(notePath) : new Set<string>();

  const applyHidden = () => {
    // Ẩn phần thân của mọi heading đang collapsed. Vùng con của một heading
    // collapsed vẫn bị ẩn do heading cha ẩn cả khối; nhưng ta ẩn theo từng
    // heading collapsed để chevron con giữ trạng thái riêng.
    for (let i = 0; i < headings.length; i++) {
      const isCollapsed = collapsed.has(keys[i]);
      headings[i].classList.toggle('is-collapsed', isCollapsed);
      if (isCollapsed) {
        for (const sib of sectionSiblings(headings[i], headings, i)) sib.hidden = true;
      }
    }
    // Đảm bảo phần không thuộc heading collapsed nào được hiện lại: reset trước.
  };

  // Reset toàn bộ hidden trước khi áp (idempotent qua nhiều lần gọi).
  const resetHidden = () => {
    for (const h of headings) {
      for (const sib of sectionSiblings(h, headings, headings.indexOf(h))) sib.hidden = false;
    }
  };

  const render = () => {
    resetHidden();
    applyHidden();
  };

  const toggle = (i: number) => {
    const key = keys[i];
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    if (notePath) saveCollapsed(notePath, collapsed);
    render();
  };

  headings.forEach((h, i) => {
    h.classList.add('heading-foldable');
    if (!h.querySelector('.heading-fold')) {
      const chevron = document.createElement('span');
      chevron.className = 'heading-fold';
      chevron.innerHTML = CHEVRON_SVG;
      chevron.addEventListener('click', (e) => {
        e.stopPropagation();
        toggle(i);
      });
      h.insertBefore(chevron, h.firstChild);
    }
  });

  render();

  setFoldControls({
    collapseAll: () => {
      keys.forEach((k) => collapsed.add(k));
      if (notePath) saveCollapsed(notePath, collapsed);
      render();
    },
    expandAll: () => {
      collapsed.clear();
      if (notePath) saveCollapsed(notePath, collapsed);
      render();
    },
  });
}
```

- [ ] **Step 3: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: không lỗi ở 2 file mới.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/headingFoldDom.ts web/src/lib/headingFoldControls.ts
git commit -m "feat(reading): DOM setup for heading fold (chevron, section hide, controls)"
```

---

### Task 3: Nối vào Preview + CSS chevron

**Files:**
- Modify: `web/src/components/Preview.tsx` (post-render `useEffect`, ~line 126–188)
- Modify: `web/src/styles/obsidian.css` (thêm rule chevron)

**Interfaces:**
- Consumes (from Task 2): `setupHeadingFold`, `setFoldControls`.

- [ ] **Step 1: Import + gọi trong post-render effect của Preview**

Trong `web/src/components/Preview.tsx`, thêm import gần các import lib khác:

```ts
import { setupHeadingFold } from '../lib/headingFoldDom';
import { setFoldControls } from '../lib/headingFoldControls';
```

Trong `useEffect(() => { const root = bodyRef.current; ... }, [html])` (effect
post-render bắt đầu ~line 126), thêm ngay sau `if (!root) return;`:

```ts
    setupHeadingFold(root, source ? null : activePath);
```

Và trong hàm cleanup `return () => { cancelled = true; };` của effect đó, đổi thành:

```ts
    return () => {
      cancelled = true;
      setFoldControls(null);
    };
```

Thêm `activePath` và `source` vào deps của effect: `}, [html, activePath, source]);`

- [ ] **Step 2: CSS chevron trong `web/src/styles/obsidian.css`**

Thêm vào cuối phần reading-view (sau các rule `.callout-fold`, ~sau line 702):

```css
/* Collapsible headings (reading view) */
.markdown-preview .heading-foldable { position: relative; }
.markdown-preview .heading-fold {
  display: inline-flex; align-items: center; justify-content: center;
  width: 1em; margin-left: -1.1em; margin-right: 0.1em;
  color: var(--text-faint); cursor: pointer;
  opacity: 0; transition: opacity var(--transition), transform var(--transition);
  vertical-align: middle;
}
.markdown-preview .heading-fold svg { width: 0.7em; height: 0.7em; }
.markdown-preview .heading-foldable:hover .heading-fold { opacity: 1; }
.markdown-preview .heading-foldable.is-collapsed .heading-fold { opacity: 1; transform: rotate(-90deg); }
@media (hover: none), (pointer: coarse) {
  .markdown-preview .heading-fold { opacity: 1; }
}
```

- [ ] **Step 3: Build web để chắc không lỗi typecheck/bundle**

Run: `cd web && npx tsc -b && npx vite build`
Expected: build thành công, không lỗi.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Preview.tsx web/src/styles/obsidian.css
git commit -m "feat(reading): wire heading fold into Preview + chevron styling"
```

---

### Task 4: Menu Collapse all / Expand all (view-header More options)

**Files:**
- Modify: `web/src/components/Workspace.tsx` (`openMoreMenu`, ~line 181–257)

**Interfaces:**
- Consumes (from Task 2): `getFoldControls`.

- [ ] **Step 1: Import trong Workspace.tsx**

Thêm gần các import lib:

```ts
import { getFoldControls } from '../lib/headingFoldControls';
```

- [ ] **Step 2: Thêm 2 mục menu (chỉ khi reading + markdown)**

Trong `openMoreMenu`, trong nhánh `else` (note thường), thêm biến sau `const sep`:

```ts
      const foldItems: ContextMenuItem[] =
        isMd && viewMode === 'reading'
          ? [
              { label: 'Collapse all headings', icon: 'chevrons-down-up', onClick: () => getFoldControls()?.collapseAll() },
              { label: 'Expand all headings', icon: 'chevrons-up-down', onClick: () => getFoldControls()?.expandAll() },
              sep,
            ]
          : [];
```

Rồi chèn `...foldItems,` vào đầu mảng `items = [ ... ]` (ngay sau `items = [`,
trước dòng backlinks):

```ts
      items = [
        ...foldItems,
        ...(isMd ? [{ label: 'Backlinks in document', icon: 'link', onClick: () => setRightPanel('backlinks') }, sep] : []),
        // ... phần còn lại giữ nguyên
```

Lưu ý: `viewMode` đã có sẵn trong scope component (line 64). Nếu icon
`chevrons-down-up`/`chevrons-up-down` chưa được đăng ký trong `Icon`, dùng icon
đã có: `chevron-down` cho collapse-all và `chevron-up` (hoặc bỏ icon) cho
expand-all. Kiểm tra ở Step 3.

- [ ] **Step 3: Kiểm tra icon tồn tại**

Run: `grep -n "chevrons-down-up\|chevrons-up-down\|chevron-down\|chevron-up" web/src/components/Icon.tsx`
Expected: nếu không có `chevrons-*`, đổi sang icon có sẵn (vd `chevron-down` /
`chevron-up`); nếu cả hai đều không có, bỏ thuộc tính `icon` khỏi 2 item.

- [ ] **Step 4: Build**

Run: `cd web && npx tsc -b && npx vite build`
Expected: build thành công.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Workspace.tsx
git commit -m "feat(reading): Collapse all / Expand all headings in More options menu"
```

---

### Task 5: Manual E2E verify (như người dùng thật) + IMPLEMENTATION_PLAN update

**Files:**
- Modify: `IMPLEMENTATION_PLAN.md` (thêm mục + nhật ký tiến độ)

- [ ] **Step 1: Chạy dev server**

Run: `npm run dev` (ở gốc repo). Mở web, đăng nhập, mở một note nhiều heading
(vd note lịch trình Tây Nguyên có "Ngày 3", "Ngày 4"). Chuyển sang **Reading**.

- [ ] **Step 2: Kiểm tra các hành vi**

  1. Hover lên heading "Ngày 3" → chevron hiện bên trái. Click → toàn bộ nội
     dung dưới "Ngày 3" ẩn tới trước "Ngày 4"; chevron xoay -90° và luôn hiện.
  2. Click lại → nội dung hiện lại.
  3. Collapse "Ngày 3", reload trang (F5) → vẫn collapsed.
  4. Menu ⋯ (More options) → "Collapse all headings" → mọi heading gọn;
     "Expand all headings" → mở hết.
  5. Thu nhỏ cửa sổ < 768px (hoặc devtools mobile) → chevron luôn hiện.
  6. Heading trong callout (`> [!note]`) và trong `![[note nhúng]]` KHÔNG có
     chevron.
  7. Đổi note khác rồi quay lại → trạng thái đúng theo từng note.

- [ ] **Step 3: Cập nhật IMPLEMENTATION_PLAN.md**

Thêm một mục `[x]` mô tả tính năng collapsible headings (reading view, persist
localStorage, breadcrumb key, collapse/expand all trong More options), cập nhật
dòng "Cập nhật lần cuối" và thêm dòng vào "Nhật ký tiến độ" với ngày 2026-07-10.

- [ ] **Step 4: Commit**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: log collapsible headings feature in implementation plan"
```

---

## Self-Review Notes

- **Spec coverage:** Reading-only (Task 3), H1–H6 (Task 2 `HEADING_SEL`), loại
  trừ callout/embed (Task 2 `foldableHeadings`), breadcrumb key + hậu tố (Task 1),
  localStorage persist theo note (Task 1), chevron hover + touch (Task 3 CSS),
  collapse/expand all trong More options (Task 4), edge case localStorage
  try/catch (Task 1), idempotent re-render (Task 2 kiểm tra `.heading-fold` tồn
  tại + reset hidden). Tất cả section spec đều có task.
- **Type consistency:** `HeadingInfo`, `computeHeadingKeys`, `loadCollapsed`,
  `saveCollapsed`, `setupHeadingFold`, `FoldControls`, `getFoldControls`/
  `setFoldControls` nhất quán giữa các task.
- **Placeholder scan:** không có TBD/TODO; mọi step có code hoặc lệnh cụ thể.
