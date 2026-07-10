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
