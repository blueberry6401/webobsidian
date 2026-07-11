/**
 * Điều hướng Outline ↔ CodeMirror. Phần trên là helper thuần (dễ test); hàm cầu
 * nối editor (jumpToHeading, activeHeadingIndex) ở cuối file.
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
