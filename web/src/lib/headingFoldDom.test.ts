// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { setupHeadingFold } from './headingFoldDom';
import { getFoldControls } from './headingFoldControls';
import { STORAGE_KEY } from './headingFold';

/** Dựng một body reading-view phẳng: h2 → p → h3 → p → h2 → p. */
function buildRoot(): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = [
    '<h2>Ngày 3</h2>',
    '<p id="p1">nội dung 3a</p>',
    '<h3>Buổi sáng</h3>',
    '<p id="p2">nội dung sáng</p>',
    '<h2>Ngày 4</h2>',
    '<p id="p3">nội dung 4a</p>',
  ].join('');
  return root;
}

const q = (root: HTMLElement, id: string) => root.querySelector<HTMLElement>('#' + id)!;
const headings = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('h2, h3')];

beforeEach(() => {
  localStorage.clear();
});

describe('setupHeadingFold', () => {
  it('chèn chevron vào mỗi heading foldable', () => {
    const root = buildRoot();
    setupHeadingFold(root, 'note.md');
    for (const h of headings(root)) {
      expect(h.querySelector('.heading-fold')).not.toBeNull();
      expect(h.classList.contains('heading-foldable')).toBe(true);
    }
  });

  it('collapse "Ngày 3" ẩn nội dung tới trước "Ngày 4", không ẩn Ngày 4', () => {
    const root = buildRoot();
    setupHeadingFold(root, 'note.md');
    const h2Ngay3 = headings(root)[0];
    (h2Ngay3.querySelector('.heading-fold') as HTMLElement).click();

    expect(q(root, 'p1').hidden).toBe(true);
    expect(root.querySelector<HTMLElement>('h3')!.hidden).toBe(true);
    expect(q(root, 'p2').hidden).toBe(true);
    // Ngày 4 và phần thân của nó KHÔNG bị ẩn.
    expect(headings(root)[2].hidden).toBe(false);
    expect(q(root, 'p3').hidden).toBe(false);
    expect(h2Ngay3.classList.contains('is-collapsed')).toBe(true);
  });

  it('persist trạng thái collapsed vào localStorage theo note', () => {
    const root = buildRoot();
    setupHeadingFold(root, 'note.md');
    (headings(root)[0].querySelector('.heading-fold') as HTMLElement).click();

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
    expect(stored['note.md']).toEqual(['Ngày 3']);

    // Render lại (DOM mới) đọc lại từ storage → vẫn ẩn.
    const root2 = buildRoot();
    setupHeadingFold(root2, 'note.md');
    expect(q(root2, 'p1').hidden).toBe(true);
    expect(headings(root2)[0].classList.contains('is-collapsed')).toBe(true);
  });

  it('collapseAll / expandAll qua controls', () => {
    const root = buildRoot();
    setupHeadingFold(root, 'note.md');
    getFoldControls()!.collapseAll();
    expect(q(root, 'p1').hidden).toBe(true);
    expect(q(root, 'p2').hidden).toBe(true);
    getFoldControls()!.expandAll();
    expect(q(root, 'p1').hidden).toBe(false);
    expect(q(root, 'p2').hidden).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('bỏ qua heading trong callout/embed', () => {
    const root = document.createElement('div');
    root.innerHTML = [
      '<h2>Chính</h2>',
      '<div class="callout-content"><h3>Trong callout</h3></div>',
      '<div class="embed-note"><h4>Trong embed</h4></div>',
    ].join('');
    setupHeadingFold(root, 'note.md');
    expect(root.querySelector('h2')!.querySelector('.heading-fold')).not.toBeNull();
    expect(root.querySelector('h3')!.querySelector('.heading-fold')).toBeNull();
    expect(root.querySelector('h4')!.querySelector('.heading-fold')).toBeNull();
  });
});
