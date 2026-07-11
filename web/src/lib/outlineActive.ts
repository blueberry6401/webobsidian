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
