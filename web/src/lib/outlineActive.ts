// Singleton phát index heading "đang xem" (scroll-spy). Editor cập nhật,
// OutlinePanel subscribe để tô sáng. Ephemeral — không nhét vào Zustand persist.
let current = -1;
// Sau một cú click-to-jump, ghim heading đó active trong một khoảng ngắn để cuộn
// lập trình (scrollIntoView) lắng xuống mà không bị scroll-spy ghi đè — quan
// trọng cho heading cuối tài liệu không cuộn được lên đỉnh (khớp Google Docs).
let pinnedUntil = 0;
const subs = new Set<(i: number) => void>();

function emit(i: number): void {
  if (i === current) return;
  current = i;
  for (const fn of subs) fn(i);
}

/** Scroll-spy: cập nhật heading đang xem — bị bỏ qua khi đang ghim (pin). */
export function setActiveHeading(i: number): void {
  if (Date.now() < pinnedUntil) return;
  emit(i);
}

/** Ghim heading `i` active ngay và chặn scroll-spy ghi đè trong `ms` mili-giây. */
export function pinActiveHeading(i: number, ms = 700): void {
  pinnedUntil = Date.now() + ms;
  emit(i);
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
