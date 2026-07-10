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
  const stopAt = headings.find((h, i) => i > idx && levelOf(h) <= level) ?? null;
  let node = heading.nextElementSibling as HTMLElement | null;
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

  const render = () => {
    // Reset toàn bộ về hiện trước (idempotent), rồi ẩn phần thân mỗi heading
    // đang collapsed. Vùng con của heading collapsed vẫn bị ẩn vì nằm trong
    // section của nó; chevron con vẫn giữ trạng thái riêng qua `keys`.
    for (let i = 0; i < headings.length; i++) {
      for (const sib of sectionSiblings(headings[i], headings, i)) sib.hidden = false;
    }
    for (let i = 0; i < headings.length; i++) {
      const isCollapsed = collapsed.has(keys[i]);
      headings[i].classList.toggle('is-collapsed', isCollapsed);
      if (isCollapsed) {
        for (const sib of sectionSiblings(headings[i], headings, i)) sib.hidden = true;
      }
    }
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
