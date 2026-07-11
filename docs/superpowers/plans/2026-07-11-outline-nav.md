# Outline Navigation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Nâng cấp Outline panel (sidebar phải) thành thanh điều hướng click-to-jump + tự động highlight heading đang xem khi cuộn (giống outline của Google Docs).

**Architecture:** Reading view của WebObsidian là CodeMirror read-only (không phải `Preview.tsx`), nên điều hướng chạy trên CM: một module `outlineNav.ts` cầu nối Outline ↔ editor (`getActiveEditor()`), dùng lại `scanDocHeadings` + hạ tầng heading-fold sẵn có. Scroll-spy phát tín hiệu qua singleton `outlineActive.ts` (giống `headingFoldControls`), Editor tính heading đang xem và bắn tín hiệu, OutlinePanel subscribe để tô sáng.

**Tech Stack:** TypeScript, React (Zustand store), CodeMirror 6, Vitest (jsdom per-file).

## Global Constraints

- Ngôn ngữ TypeScript, tránh `any`.
- Không thêm DB engine; state ephemeral không nhét vào Zustand persist.
- Không log secret/token.
- Không đụng split-pane `Preview.tsx` / mobile embed — chỉ khung editor chính.
- Vitest: file cần DOM/`localStorage` phải mở đầu bằng `// @vitest-environment jsdom`.
- Commit sau mỗi task; git push/deploy chỉ khi tới bước deploy.

---

### Task 1: Đồng bộ bộ quét heading giữa Outline và editor

Sửa `outline()` để bỏ qua fenced code block (khớp `scanDocHeadings`), và export `scanDocHeadings` + `DocHeading` để `outlineNav.ts` dùng. Test bất biến: cùng input → hai hàm cho cùng chuỗi `{level,text}`.

**Files:**
- Modify: `web/src/lib/markdown.ts` (hàm `outline`, ~dòng 296-304)
- Modify: `web/src/lib/livePreview.ts` (export `scanDocHeadings`, `DocHeading` ~dòng 836-859)
- Test: `web/src/lib/outlineSync.test.ts` (create)

**Interfaces:**
- Produces: `outline(src: string): { level: number; text: string }[]` (chữ ký giữ nguyên, nay bỏ qua fenced code).
- Produces: `export function scanDocHeadings(doc: Text): DocHeading[]`; `export interface DocHeading { level: number; text: string; lineFrom: number; lineTo: number; lineNo: number }`.

- [ ] **Step 1: Viết test thất bại**

Tạo `web/src/lib/outlineSync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import { outline } from './markdown';
import { scanDocHeadings } from './livePreview';

const SRC = [
  '# Trip',
  '',
  'Intro',
  '',
  '## Ngày 1',
  '',
  '```bash',
  '# not a heading',
  '## also not',
  '```',
  '',
  '## Ngày 2',
  '### Sáng',
].join('\n');

describe('outline() skips fenced code', () => {
  it('không tính dòng # trong ``` như heading', () => {
    expect(outline(SRC).map((h) => h.text)).toEqual([
      'Trip', 'Ngày 1', 'Ngày 2', 'Sáng',
    ]);
  });

  it('khớp scanDocHeadings về {level,text}', () => {
    const a = outline(SRC).map((h) => ({ level: h.level, text: h.text }));
    const b = scanDocHeadings(Text.of(SRC.split('\n'))).map((h) => ({ level: h.level, text: h.text }));
    expect(a).toEqual(b);
  });
});
```

- [ ] **Step 2: Chạy test để xác nhận fail**

Run: `cd web && npx vitest run src/lib/outlineSync.test.ts`
Expected: FAIL — `scanDocHeadings` chưa export (import error) và/hoặc `outline` còn tính heading trong code.

- [ ] **Step 3: Export scanDocHeadings + DocHeading trong livePreview.ts**

Sửa `interface DocHeading {` (dòng ~836) thành `export interface DocHeading {`, và `function scanDocHeadings(doc: Text): DocHeading[] {` (dòng ~845) thành `export function scanDocHeadings(doc: Text): DocHeading[] {`.

- [ ] **Step 4: Sửa outline() bỏ qua fenced code**

Thay thân hàm `outline` trong `web/src/lib/markdown.ts`:

```ts
/** Build an outline (headings) for the outline panel. Bỏ qua heading giả nằm
 *  trong fenced code block để khớp scanDocHeadings (nguồn sự thật khi jump). */
export function outline(src: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  let inFence = false;
  for (const line of src.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}
```

- [ ] **Step 5: Chạy test để xác nhận pass**

Run: `cd web && npx vitest run src/lib/outlineSync.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/markdown.ts web/src/lib/livePreview.ts web/src/lib/outlineSync.test.ts
git commit -m "feat(outline): sync heading scanning (skip fenced code) + export scanDocHeadings"
```

---

### Task 2: Helper thuần + store active heading

Hai module nhỏ, thuần logic, dễ test: `outlineActive.ts` (singleton phát index đang xem) và các helper thuần trong `outlineNav.ts` (`pickActiveHeading`, `ancestorIndices`). Phần cầu nối CodeMirror thêm ở Task 3.

**Files:**
- Create: `web/src/lib/outlineActive.ts`
- Create: `web/src/lib/outlineNav.ts` (chỉ phần helper thuần ở task này)
- Test: `web/src/lib/outlineActive.test.ts`
- Test: `web/src/lib/outlineNav.test.ts`

**Interfaces:**
- Produces: `setActiveHeading(i: number): void`, `getActiveHeading(): number`, `subscribeActiveHeading(fn: (i: number) => void): () => void`.
- Produces: `pickActiveHeading(tops: number[], scrollTop: number, topMargin: number): number`.
- Produces: `ancestorIndices(levels: number[], target: number): number[]`.

- [ ] **Step 1: Viết test thất bại cho outlineActive**

Tạo `web/src/lib/outlineActive.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setActiveHeading, getActiveHeading, subscribeActiveHeading } from './outlineActive';

beforeEach(() => setActiveHeading(-1));

describe('outlineActive store', () => {
  it('lưu và trả về index hiện tại', () => {
    setActiveHeading(3);
    expect(getActiveHeading()).toBe(3);
  });

  it('gọi subscriber khi đổi, bỏ qua khi trùng', () => {
    let calls = 0;
    let last = -99;
    const un = subscribeActiveHeading((i) => { calls++; last = i; });
    setActiveHeading(2);
    setActiveHeading(2); // trùng → no-op
    setActiveHeading(5);
    expect(calls).toBe(2);
    expect(last).toBe(5);
    un();
    setActiveHeading(7);
    expect(calls).toBe(2); // đã unsubscribe
  });
});
```

- [ ] **Step 2: Viết test thất bại cho helper thuần**

Tạo `web/src/lib/outlineNav.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { pickActiveHeading, ancestorIndices } from './outlineNav';

describe('pickActiveHeading', () => {
  const tops = [0, 100, 250, 400]; // top px mỗi heading (tăng dần)
  it('trả về heading đầu khi chưa cuộn', () => {
    expect(pickActiveHeading(tops, 0, 40)).toBe(0);
  });
  it('chọn heading gần nhất phía trên mốc scrollTop+margin', () => {
    expect(pickActiveHeading(tops, 120, 40)).toBe(1); // 160 ≥ 100, < 250
    expect(pickActiveHeading(tops, 220, 40)).toBe(2); // 260 ≥ 250
  });
  it('trả -1 khi rỗng', () => {
    expect(pickActiveHeading([], 0, 40)).toBe(-1);
  });
});

describe('ancestorIndices', () => {
  // levels: H1, H2, H3, H2, H1 ...
  const levels = [1, 2, 3, 2, 1, 2];
  it('trả các tổ tiên cấp nhỏ hơn (deepest-first)', () => {
    // target = index 2 (H3): tổ tiên là index 1 (H2), index 0 (H1)
    expect(ancestorIndices(levels, 2)).toEqual([1, 0]);
  });
  it('không có tổ tiên cho heading cấp cao nhất', () => {
    expect(ancestorIndices(levels, 4)).toEqual([]); // H1
  });
  it('bỏ qua sibling cùng/lớn hơn cấp', () => {
    expect(ancestorIndices(levels, 5)).toEqual([4]); // H2 → chỉ H1 index 4
  });
});
```

- [ ] **Step 3: Chạy test để xác nhận fail**

Run: `cd web && npx vitest run src/lib/outlineActive.test.ts src/lib/outlineNav.test.ts`
Expected: FAIL — module chưa tồn tại.

- [ ] **Step 4: Viết outlineActive.ts**

```ts
// Singleton phát index heading "đang xem" (scroll-spy). Editor cập nhật,
// OutlinePanel subscribe để tô sáng. Ephemeral — không nhét vào Zustand persist.
let current = -1;
const subs = new Set<(i: number) => void>();

export function setActiveHeading(i: number): void {
  if (i === current) return;
  current = i;
  for (const fn of subs) fn(i);
}

export function getActiveHeading(): number {
  return current;
}

export function subscribeActiveHeading(fn: (i: number) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}
```

- [ ] **Step 5: Viết outlineNav.ts (chỉ helper thuần)**

```ts
/**
 * Điều hướng Outline ↔ CodeMirror. Task này chỉ chứa helper thuần; hàm cầu nối
 * editor (jumpToHeading, activeHeadingIndex) thêm ở Task 3.
 */

/** Heading "đang xem" = heading cuối cùng có top ≤ scrollTop + topMargin.
 *  `tops` tăng dần (thứ tự tài liệu). Trả 0 khi chưa cuộn qua heading nào,
 *  -1 khi không có heading. */
export function pickActiveHeading(tops: number[], scrollTop: number, topMargin: number): number {
  if (tops.length === 0) return -1;
  const threshold = scrollTop + topMargin;
  let idx = 0;
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= threshold) idx = i;
    else break;
  }
  return idx;
}

/** Chỉ số các heading tổ tiên (cấp nhỏ hơn, thu hẹp dần) của heading `target`,
 *  deepest-first. Dùng để mở các section collapsed che khuất target. */
export function ancestorIndices(levels: number[], target: number): number[] {
  const out: number[] = [];
  let need = levels[target];
  for (let i = target - 1; i >= 0; i--) {
    if (levels[i] < need) {
      out.push(i);
      need = levels[i];
    }
  }
  return out;
}
```

- [ ] **Step 6: Chạy test để xác nhận pass**

Run: `cd web && npx vitest run src/lib/outlineActive.test.ts src/lib/outlineNav.test.ts`
Expected: PASS (outlineActive 2, outlineNav 6).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/outlineActive.ts web/src/lib/outlineNav.ts web/src/lib/outlineActive.test.ts web/src/lib/outlineNav.test.ts
git commit -m "feat(outline): active-heading store + pure nav helpers"
```

---

### Task 3: Cầu nối CodeMirror — jumpToHeading + activeHeadingIndex

Thêm hai hàm phụ thuộc editor vào `outlineNav.ts`. Không unit-test (cần `EditorView` thật) — verify qua build/typecheck ở đây và E2E ở Task 5.

**Files:**
- Modify: `web/src/lib/outlineNav.ts` (thêm import + 2 hàm)

**Interfaces:**
- Consumes: `getActiveEditor()` từ `./activeEditor`; `scanDocHeadings`, `livePreviewReadonly`, `notePathField`, `headingFoldRefresh` từ `./livePreview`; `computeHeadingKeys`, `loadCollapsed`, `saveCollapsed` từ `./headingFold`; `EditorView` từ `@codemirror/view`; `pickActiveHeading`, `ancestorIndices` (cùng file).
- Produces: `jumpToHeading(index: number): boolean`, `activeHeadingIndex(view: EditorView, topMargin?: number): number`.

- [ ] **Step 1: Thêm import + 2 hàm vào đầu/cuối outlineNav.ts**

Thêm import ở đầu file (trên các helper thuần):

```ts
import { EditorView } from '@codemirror/view';
import { getActiveEditor } from './activeEditor';
import { scanDocHeadings, livePreviewReadonly, notePathField, headingFoldRefresh } from './livePreview';
import { computeHeadingKeys, loadCollapsed, saveCollapsed } from './headingFold';
```

Thêm hai hàm ở cuối file:

```ts
/** Cuộn editor đang hoạt động tới heading thứ `index` (theo scanDocHeadings).
 *  Ở Reading: mở các section collapsed che khuất heading trước khi cuộn. Trả
 *  false nếu không có editor hoặc index ngoài phạm vi. */
export function jumpToHeading(index: number): boolean {
  const view = getActiveEditor();
  if (!view) return false;
  const heads = scanDocHeadings(view.state.doc);
  if (index < 0 || index >= heads.length) return false;

  const reading = view.state.field(livePreviewReadonly, false) ?? false;
  if (reading) {
    const np = view.state.field(notePathField, false) ?? null;
    const keys = computeHeadingKeys(heads.map((h) => ({ level: h.level, text: h.text })));
    const collapsed = np ? loadCollapsed(np) : new Set<string>();
    let changed = false;
    for (const a of ancestorIndices(heads.map((h) => h.level), index)) {
      if (collapsed.delete(keys[a])) changed = true;
    }
    if (changed) {
      if (np) saveCollapsed(np, collapsed);
      // Rebuild deco trước để hình học đúng khi scrollIntoView bên dưới.
      view.dispatch({ effects: headingFoldRefresh.of(null) });
    }
  }

  const pos = heads[index].lineFrom;
  view.dispatch({
    selection: reading ? undefined : { anchor: pos },
    effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 8 }),
  });
  if (!reading) view.focus();
  return true;
}

/** Chỉ số heading đang xem theo vị trí cuộn của `view`. */
export function activeHeadingIndex(view: EditorView, topMargin = 40): number {
  const heads = scanDocHeadings(view.state.doc);
  if (heads.length === 0) return -1;
  const tops = heads.map((h) => view.lineBlockAt(h.lineFrom).top);
  return pickActiveHeading(tops, view.scrollDOM.scrollTop, topMargin);
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit`
Expected: PASS (không lỗi type).

- [ ] **Step 3: Chạy lại toàn bộ test lib để không hồi quy**

Run: `cd web && npx vitest run src/lib`
Expected: PASS toàn bộ (bao gồm helper thuần vẫn đúng).

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/outlineNav.ts
git commit -m "feat(outline): jumpToHeading + activeHeadingIndex CodeMirror bridge"
```

---

### Task 4: Scroll-spy trong Editor.tsx

Editor tính `activeHeadingIndex` và bắn `setActiveHeading` khi cuộn / đổi geometry / sửa doc (throttle bằng rAF); reset về -1 khi unmount.

**Files:**
- Modify: `web/src/components/Editor.tsx` (import, throttle helper, updateListener + scroll handler, cleanup)

**Interfaces:**
- Consumes: `activeHeadingIndex` từ `../lib/outlineNav`, `setActiveHeading` từ `../lib/outlineActive`.

- [ ] **Step 1: Thêm import**

Thêm vào cụm import của `Editor.tsx`:

```ts
import { activeHeadingIndex } from '../lib/outlineNav';
import { setActiveHeading } from '../lib/outlineActive';
```

- [ ] **Step 2: Thêm throttle helper trong effect tạo view**

Ngay trước `const state = EditorState.create({` (nơi khai báo `let scrollSaveTimer = 0;` ~dòng 280), thêm:

```ts
let activeRaf = 0;
const scheduleActiveHeading = (v: EditorView) => {
  if (activeRaf) return;
  activeRaf = requestAnimationFrame(() => {
    activeRaf = 0;
    setActiveHeading(activeHeadingIndex(v));
  });
};
```

- [ ] **Step 3: Gọi từ updateListener + scroll handler**

Trong `EditorView.updateListener.of((u) => { ... })` hiện có (dòng ~334), thêm sau dòng `setContent`:

```ts
          if (u.geometryChanged || u.viewportChanged || u.docChanged) scheduleActiveHeading(u.view);
```

Trong `EditorView.domEventHandlers({ scroll: ... })` (dòng ~338), thêm dòng cuối trong handler `scroll` (sau khối `scrollSaveTimer`):

```ts
            scheduleActiveHeading(ev);
```

- [ ] **Step 4: Tính lần đầu + cleanup reset**

Sau `setActiveEditor(v); v.focus();` (dòng ~349-350) thêm:

```ts
    scheduleActiveHeading(v);
```

Trong hàm cleanup `return () => { ... }` của effect này (dòng ~355), thêm trước `setActiveEditor(null);`:

```ts
      if (activeRaf) cancelAnimationFrame(activeRaf);
      setActiveHeading(-1);
```

- [ ] **Step 5: Typecheck + build web**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: PASS, build tạo bundle không lỗi.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/Editor.tsx
git commit -m "feat(outline): scroll-spy — Editor phát heading đang xem"
```

---

### Task 5: OutlinePanel click-to-jump + highlight + CSS

`OutlinePanel` gọi `jumpToHeading(i)` khi click, tô `.is-active` theo `subscribeActiveHeading`, cuộn mục active vào tầm nhìn. Thêm CSS trạng thái active.

**Files:**
- Modify: `web/src/components/RightSidebar.tsx` (`OutlinePanel`, import)
- Modify: `web/src/styles/obsidian.css` (`.outline-item.is-active`, sau dòng ~900)

**Interfaces:**
- Consumes: `jumpToHeading` từ `../lib/outlineNav`; `subscribeActiveHeading`, `getActiveHeading` từ `../lib/outlineActive`; `useSyncExternalStore`, `useRef`, `useEffect` từ `react`.

- [ ] **Step 1: Thêm import ở đầu RightSidebar.tsx**

Bảo đảm dòng import React có `useEffect, useRef, useSyncExternalStore` (thêm cái thiếu). Thêm:

```ts
import { jumpToHeading } from '../lib/outlineNav';
import { subscribeActiveHeading, getActiveHeading } from '../lib/outlineActive';
```

- [ ] **Step 2: Thay hàm OutlinePanel**

Thay nguyên `function OutlinePanel() { ... }` (dòng ~217-235) bằng:

```tsx
function OutlinePanel() {
  const content = useStore((s) => s.content);
  const heads = outline(content);
  const active = useSyncExternalStore(subscribeActiveHeading, getActiveHeading);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Cuộn mục đang active vào tầm nhìn của panel khi note dài.
  useEffect(() => {
    bodyRef.current?.querySelector('.outline-item.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <>
      <div className="nav-header">
        <span className="nav-title">Outline</span>
      </div>
      <div className="sidebar-body" ref={bodyRef}>
        {heads.length === 0 && <div className="panel-item">No headings</div>}
        {heads.map((h, i) => (
          <div
            key={i}
            className={'outline-item' + (i === active ? ' is-active' : '')}
            style={{ paddingLeft: 10 + (h.level - 1) * 12 }}
            onClick={() => jumpToHeading(i)}
          >
            {h.text}
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Thêm CSS trạng thái active**

Sau dòng `.outline-item:hover { ... }` (dòng ~900) trong `web/src/styles/obsidian.css`, thêm:

```css
.outline-item.is-active {
  color: var(--text-normal);
  background: var(--bg-modifier-hover);
  box-shadow: inset 2px 0 0 var(--interactive-accent);
}
```

- [ ] **Step 4: Typecheck + build web**

Run: `cd web && npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/RightSidebar.tsx web/src/styles/obsidian.css
git commit -m "feat(outline): click-to-jump + active highlight in Outline panel"
```

---

### Task 6: Verify E2E thật + cập nhật tài liệu

Chạy app thật, kiểm chứng như người dùng. Cập nhật IMPLEMENTATION_PLAN.md (nhật ký tiến độ) — PRD đã mô tả Outline panel, không cần đổi thiết kế.

**Files:**
- Modify: `IMPLEMENTATION_PLAN.md` (thêm mục + nhật ký)

- [ ] **Step 1: Chạy toàn bộ test + build sạch**

Run: `cd web && npx vitest run && npm run build` rồi `cd .. && npm run typecheck`
Expected: tất cả test PASS, build + typecheck sạch.

- [ ] **Step 2: E2E thủ công (real app)**

Chạy `npm run dev`, mở một note nhiều heading (dùng file trip trong ảnh tham chiếu nếu có, hoặc tạo note test H1–H3 + code fence). Kiểm:
  1. Reading: Outline liệt kê đúng, không có heading trong ``` code.
  2. Click từng mục → editor cuộn tới đúng heading.
  3. Cuộn tay → mục tương ứng sáng lên (thanh accent trái), tự cuộn theo trong panel.
  4. Thu gọn một section rồi click heading con bên trong → tự mở + cuộn tới.
  5. Chuyển Editing (Live) → click + highlight vẫn hoạt động, click đưa caret tới heading.
Ghi lại kết quả (pass/fail từng mục).

- [ ] **Step 3: Cập nhật IMPLEMENTATION_PLAN.md**

Thêm một mục đánh dấu `[x]` cho tính năng outline navigation ở phase phù hợp, cập nhật dòng "Cập nhật lần cuối", thêm dòng nhật ký ngày 2026-07-11 tóm tắt (click-to-jump + scroll-spy, đồng bộ scan heading).

- [ ] **Step 4: Commit**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: log outline navigation (click-to-jump + scroll-spy)"
```

---

### Task 7: Deploy production

Merge nhánh worktree về `main` (fork), push, rebuild droplet `obsidian.henry-group.uk`. Theo `~/Documents/Projects/_deployments/webobsidian-web.md`.

- [ ] **Step 1: Merge về main + push fork**

Theo finishing-a-development-branch: merge nhánh này vào `main`, push `fork main`.

- [ ] **Step 2: Rebuild droplet + healthz**

Theo runbook deploy (SSH droplet, pull, `npm run build`, restart service), verify `/healthz` OK và bundle mới phục vụ.

- [ ] **Step 3: Smoke test live**

Mở prod, xác nhận Outline panel click-to-jump + highlight hoạt động trên một note thật.

## Self-Review

**Spec coverage:**
- Đồng bộ bộ quét heading → Task 1. ✓
- Click-to-jump (+ mở ancestor collapsed khi Reading) → Task 2 (ancestorIndices) + Task 3 (jumpToHeading). ✓
- Scroll-spy highlight → Task 2 (pickActiveHeading, store) + Task 3 (activeHeadingIndex) + Task 4 (Editor) + Task 5 (panel). ✓
- Phạm vi chỉ editor chính, không đụng Preview.tsx → không sửa Preview.tsx ở task nào. ✓
- Test bất biến outline↔scanDocHeadings → Task 1 Step 1. ✓
- CSS active state → Task 5 Step 3. ✓

**Placeholder scan:** Không có TBD/TODO; mọi step có code/lệnh cụ thể + expected output.

**Type consistency:** `jumpToHeading(index: number): boolean`, `activeHeadingIndex(view, topMargin?)`, `pickActiveHeading(tops, scrollTop, topMargin)`, `ancestorIndices(levels, target)`, `setActiveHeading/getActiveHeading/subscribeActiveHeading` — dùng nhất quán giữa các task (Task 2 định nghĩa, Task 3/4/5 tiêu thụ đúng tên & kiểu). `scanDocHeadings(doc: Text)` / `DocHeading` export ở Task 1, tiêu thụ ở Task 3. ✓
