/**
 * Điều hướng Outline ↔ CodeMirror. Phần trên là helper thuần (dễ test); hàm cầu
 * nối editor (jumpToHeading, activeHeadingIndex) ở cuối file.
 */
import { EditorView } from '@codemirror/view';
import { getActiveEditor } from './activeEditor';
import { scanDocHeadings, livePreviewReadonly, notePathField, headingFoldRefresh } from './livePreview';
import { computeHeadingKeys, loadCollapsed, saveCollapsed } from './headingFold';
import { pinActiveHeading } from './outlineActive';

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

/** Cuộn editor đang hoạt động tới heading thứ `index` (theo scanDocHeadings).
 *  Ở Reading: mở các section collapsed che khuất heading trước khi cuộn. Trả
 *  false nếu không có editor hoặc index ngoài phạm vi. */
export function jumpToHeading(index: number): boolean {
  const view = getActiveEditor();
  if (!view) return false;
  const heads = scanDocHeadings(view.state.doc);
  if (index < 0 || index >= heads.length) return false;

  // Ghim mục vừa click active ngay (Google Docs highlight đúng mục dù không cuộn
  // được lên đỉnh với heading cuối tài liệu).
  pinActiveHeading(index);

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
