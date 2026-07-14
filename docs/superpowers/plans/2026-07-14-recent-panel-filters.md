# Quick Filter File Explorer + Recent 3-Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a diacritic/space-insensitive filename quick filter to the File Explorer, and turn the
sidebar "Recent" panel into a 3-mode (Opened/Created/Modified) list with 1 week/1 month/3 months/All
quick-range buttons, so a growing vault stays navigable by "what's new" instead of only "what I
clicked".

**Architecture:** Both features are 100% client-side. The file tree already carries `mtime`/`ctime`
per file (server `vault.ts` stat cache, Phase 29) and workspace state (`recent`) already round-trips
through a schema-less `/api/uistate` blob — so no server route or schema changes are needed anywhere
in this plan. New pure-logic helpers (`normalize.ts`, `flattenFiles`, `recentList.ts`) get Vitest
unit tests, matching the project's existing convention (`web/src/lib/*.test.ts`, `vitest.config.ts`
already wired to `npm --workspace web run test`). The two React components then wire these helpers
into `FileTree.tsx` and `BookmarksPanel.tsx`. UI behavior is verified with an ad-hoc Playwright
script against the real dev server (same pattern the repo's Phase 30/31 changelog entries describe:
"Verify Playwright headless server thật") — not committed, since no Playwright infra exists in this
repo (`.tsx` component tests aren't part of this project's convention either — `vitest.config.ts`
only includes `src/**/*.test.ts`).

**Tech Stack:** TypeScript, React 18, Zustand (`web/src/lib/store.ts`), Vitest, Playwright (ad-hoc,
via `npx`/local package install, not a repo dependency).

## Global Constraints

- UI copy stays in English (existing convention throughout `Sidebar.tsx`/`SearchPanel.tsx`/
  `BookmarksPanel.tsx` — e.g. "No bookmarks yet", "Search options"). Vietnamese is used only in
  code comments/commit messages/docs, never in rendered UI strings, in this codebase.
  Vietnamese-language design intent (mode names, range labels) is translated: Opened/Created/
  Modified, 1 week/1 month/3 months/All.
- No server changes. Both features consume data the client already has (`tree.mtime`/`ctime`,
  `/api/uistate` schema-less blob).
- `recent` cap raises from 20 to `RECENT_CAP = 200` (per approved design), only in `store.ts`.
- Reuse existing CSS classes where possible: the file-filter input reuses `.search-input-wrap` /
  `.search-lead` / `.search-input.has-lead` / `.search-icon-btn` (already defined in
  `web/src/styles/obsidian.css`, used by `SearchPanel.tsx`) — no new CSS needed for Task 5. Only
  the Recent panel's mode/range toggle rows need new CSS (Task 6).
- Every task ends with `npm run typecheck` passing (root script runs both server + web
  `tsc --noEmit`) before commit.
- Base branch for this whole feature is `fork/main` (confirmed with user — `origin` is a
  read-only upstream mirror, `fork` is the actual push target). This worktree branch was rebased
  onto `fork/main` before this plan was written.

---

### Task 1: `normalizeForFilter` / `matchesQuery` helper

**Files:**
- Create: `web/src/lib/normalize.ts`
- Test: `web/src/lib/normalize.test.ts`

**Interfaces:**
- Produces: `normalizeForFilter(s: string): string`, `matchesQuery(text: string, query: string): boolean`
  — consumed by Task 5 (`FileTree.tsx`).

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { normalizeForFilter, matchesQuery } from './normalize';

describe('normalizeForFilter', () => {
  it('lowercases, strips Vietnamese diacritics and đ/Đ, removes whitespace', () => {
    expect(normalizeForFilter('Đà Nẵng')).toBe('danang');
    expect(normalizeForFilter('  Da   Nang  ')).toBe('danang');
    expect(normalizeForFilter('Hello World')).toBe('helloworld');
  });
  it('leaves already-plain ascii untouched apart from case/space', () => {
    expect(normalizeForFilter('Report.md')).toBe('report.md');
  });
});

describe('matchesQuery', () => {
  it('matches diacritic-insensitive, space-insensitive substrings', () => {
    expect(matchesQuery('Đà Nẵng.md', 'danang')).toBe(true);
    expect(matchesQuery('Đà Nẵng.md', 'da nang')).toBe(true);
    expect(matchesQuery('Đà Nẵng.md', 'DANANG')).toBe(true);
  });
  it('does not match unrelated names', () => {
    expect(matchesQuery('Đà Lạt.md', 'danang')).toBe(false);
  });
  it('empty (or whitespace-only) query matches everything', () => {
    expect(matchesQuery('anything.md', '')).toBe(true);
    expect(matchesQuery('anything.md', '   ')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace web run test -- normalize`
Expected: FAIL — `Cannot find module './normalize'` (file doesn't exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `web/src/lib/normalize.ts`:

```ts
/** Lowercase, strip Vietnamese diacritics (incl. đ/Đ) and whitespace — for filename filtering. */
export function normalizeForFilter(s: string): string {
  return s
    .toLowerCase()
    .replace(/đ/g, 'd')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, '');
}

/**
 * True if `text` contains `query` once both are normalized (diacritic/space/case-insensitive).
 * An empty (or whitespace-only) query matches everything.
 */
export function matchesQuery(text: string, query: string): boolean {
  const q = normalizeForFilter(query);
  if (!q) return true;
  return normalizeForFilter(text).includes(q);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace web run test -- normalize`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/normalize.ts web/src/lib/normalize.test.ts
git commit -m "feat(filetree): add diacritic/space-insensitive normalizeForFilter/matchesQuery"
```

---

### Task 2: `flattenFiles` tree helper

**Files:**
- Modify: `web/src/lib/tree.ts` (append)
- Test: `web/src/lib/tree.test.ts`

**Interfaces:**
- Consumes: `TreeNode` from `web/src/lib/api.ts` (already imported in `tree.ts`).
- Produces: `interface FlatFile { path: string; name: string; mtime: number; ctime: number }`,
  `flattenFiles(root: TreeNode | null): FlatFile[]` — consumed by Task 6 (`BookmarksPanel.tsx`).

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/tree.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { flattenFiles } from './tree';
import type { TreeNode } from './api';

const fixture: TreeNode = {
  name: 'root',
  path: '',
  type: 'folder',
  children: [
    { name: 'Note A.md', path: 'Note A.md', type: 'file', mtime: 300, ctime: 100 },
    {
      name: 'Trips',
      path: 'Trips',
      type: 'folder',
      children: [
        { name: 'Note B.md', path: 'Trips/Note B.md', type: 'file', mtime: 200, ctime: 50 },
        {
          name: 'Nested',
          path: 'Trips/Nested',
          type: 'folder',
          children: [
            { name: 'Note C.md', path: 'Trips/Nested/Note C.md', type: 'file', mtime: 400, ctime: 10 },
          ],
        },
      ],
    },
  ],
};

describe('flattenFiles', () => {
  it('collects every file node across nested folders, skipping folders themselves', () => {
    const paths = flattenFiles(fixture).map((f) => f.path).sort();
    expect(paths).toEqual(['Note A.md', 'Trips/Nested/Note C.md', 'Trips/Note B.md'].sort());
  });
  it('carries mtime/ctime through unchanged', () => {
    const b = flattenFiles(fixture).find((f) => f.path === 'Trips/Note B.md');
    expect(b).toEqual({ path: 'Trips/Note B.md', name: 'Note B.md', mtime: 200, ctime: 50 });
  });
  it('defaults missing mtime/ctime to 0', () => {
    const noStat: TreeNode = { name: 'x.md', path: 'x.md', type: 'file' };
    const flat = flattenFiles({ name: 'root', path: '', type: 'folder', children: [noStat] });
    expect(flat).toEqual([{ path: 'x.md', name: 'x.md', mtime: 0, ctime: 0 }]);
  });
  it('returns an empty array for a null tree', () => {
    expect(flattenFiles(null)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace web run test -- tree.test`
Expected: FAIL — `flattenFiles is not exported` / `undefined is not a function`.

- [ ] **Step 3: Write minimal implementation**

Append to `web/src/lib/tree.ts` (after the existing `pruneDescendants` function):

```ts

export interface FlatFile {
  path: string;
  name: string;
  mtime: number;
  ctime: number;
}

/** Every file node in the tree (folders skipped, order not significant). */
export function flattenFiles(root: TreeNode | null): FlatFile[] {
  if (!root) return [];
  const out: FlatFile[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children ?? []) {
      if (c.type === 'file') out.push({ path: c.path, name: c.name, mtime: c.mtime ?? 0, ctime: c.ctime ?? 0 });
      else walk(c);
    }
  };
  walk(root);
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace web run test -- tree.test`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/tree.ts web/src/lib/tree.test.ts
git commit -m "feat(tree): add flattenFiles helper for vault-wide file lists"
```

---

### Task 3: `recentList` range filter/sort helper

**Files:**
- Create: `web/src/lib/recentList.ts`
- Test: `web/src/lib/recentList.test.ts`

**Interfaces:**
- Produces: `type RecentMode = 'opened' | 'created' | 'modified'`, `type RecentRange = 'week' | 'month' | '3months' | 'all'`,
  `interface RecentItem { path: string; time: number }`,
  `filterAndSortRecent(items: RecentItem[], range: RecentRange, now?: number): RecentItem[]`
  — consumed by Task 6 (`BookmarksPanel.tsx`).

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/recentList.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterAndSortRecent, type RecentItem } from './recentList';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

const items: RecentItem[] = [
  { path: 'a.md', time: NOW - 1 * DAY_MS }, // 1 day ago
  { path: 'b.md', time: NOW - 20 * DAY_MS }, // 20 days ago
  { path: 'c.md', time: NOW - 60 * DAY_MS }, // 60 days ago
  { path: 'd.md', time: NOW - 200 * DAY_MS }, // 200 days ago
];

describe('filterAndSortRecent', () => {
  it('week keeps only items from the last 7 days', () => {
    expect(filterAndSortRecent(items, 'week', NOW).map((i) => i.path)).toEqual(['a.md']);
  });
  it('month keeps items from the last 30 days, newest first', () => {
    expect(filterAndSortRecent(items, 'month', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md']);
  });
  it('3months keeps items from the last 90 days', () => {
    expect(filterAndSortRecent(items, '3months', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md']);
  });
  it('all keeps everything, sorted newest first', () => {
    expect(filterAndSortRecent(items, 'all', NOW).map((i) => i.path)).toEqual(['a.md', 'b.md', 'c.md', 'd.md']);
  });
  it('returns an empty array for empty input', () => {
    expect(filterAndSortRecent([], 'all', NOW)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --workspace web run test -- recentList`
Expected: FAIL — `Cannot find module './recentList'`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/lib/recentList.ts`:

```ts
export type RecentMode = 'opened' | 'created' | 'modified';
export type RecentRange = 'week' | 'month' | '3months' | 'all';

export interface RecentItem {
  path: string;
  time: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RANGE_MS: Record<Exclude<RecentRange, 'all'>, number> = {
  week: 7 * DAY_MS,
  month: 30 * DAY_MS,
  '3months': 90 * DAY_MS,
};

/** Keep items within `range` of `now`, newest first. `range === 'all'` keeps everything. */
export function filterAndSortRecent(items: RecentItem[], range: RecentRange, now = Date.now()): RecentItem[] {
  const cutoff = range === 'all' ? -Infinity : now - RANGE_MS[range];
  return items.filter((i) => i.time >= cutoff).sort((a, b) => b.time - a.time);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --workspace web run test -- recentList`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/recentList.ts web/src/lib/recentList.test.ts
git commit -m "feat(recent): add filterAndSortRecent range helper"
```

---

### Task 4: `store.ts` — `recent` becomes `{path, openedAt}[]`, cap 200, migrate old data

**Files:**
- Modify: `web/src/lib/store.ts:24-27` (add type), `:128` (field type), `:233` (cap constant),
  `:253-265` (migration fn), `:277` (apply), `:390-391` (default/removeRecent), `:528` (openFile push)

**Interfaces:**
- Produces: `export interface RecentEntry { path: string; openedAt: number }` — consumed by Task 6
  (`BookmarksPanel.tsx` reads `store.recent: RecentEntry[]`).

- [ ] **Step 1: Add the `RecentEntry` type**

In `web/src/lib/store.ts`, after the `Tab` interface (currently lines 24-27):

```ts
export interface Tab {
  path: string;
  title: string;
}

/** One entry in the "Opened" recent-files history: path + the timestamp it was last opened. */
export interface RecentEntry {
  path: string;
  openedAt: number;
}
```

- [ ] **Step 2: Change the `recent` field type in `AppState`**

Find (line 128):
```ts
  recent: string[];
```
Replace with:
```ts
  recent: RecentEntry[];
```

- [ ] **Step 3: Add the cap constant**

Find (line 233):
```ts
const TEXT_RE = /\.(md|markdown|txt|json|csv|canvas|css|js|ya?ml)$/i;
```
Replace with:
```ts
const TEXT_RE = /\.(md|markdown|txt|json|csv|canvas|css|js|ya?ml)$/i;
/** Max entries kept in the "Opened" recent-files history (raised from 20 so the 3-month range filter is meaningful). */
const RECENT_CAP = 200;
```

- [ ] **Step 4: Add the migration function**

Find `migrateGraphSettings` (ends right before `function applyPersisted`, around line 265). Insert
right after its closing brace, before `applyPersisted`:

```ts
/** Legacy `recent` was `string[]`; migrate entries to `{path, openedAt}` (openedAt=0 sorts to the bottom under "All"). */
function migrateRecent(raw: unknown): RecentEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => (typeof e === 'string' ? { path: e, openedAt: 0 } : e))
    .filter((e): e is RecentEntry => !!e && typeof e === 'object' && typeof (e as any).path === 'string' && typeof (e as any).openedAt === 'number')
    .slice(0, RECENT_CAP);
}
```

- [ ] **Step 5: Use the migration in `applyPersisted`**

Find (line 277):
```ts
    recent: Array.isArray(s.recent) ? s.recent : [],
```
Replace with:
```ts
    recent: migrateRecent(s.recent),
```

- [ ] **Step 6: Fix `removeRecent`'s predicate for the new shape**

Find (line 391):
```ts
      removeRecent: (path) => set((s) => ({ recent: s.recent.filter((p) => p !== path) })),
```
Replace with:
```ts
      removeRecent: (path) => set((s) => ({ recent: s.recent.filter((e) => e.path !== path) })),
```

(Line 390 `recent: [],` stays unchanged — an empty array is valid for both the old and new type.)

- [ ] **Step 7: Push `{path, openedAt}` in `openFile`, raise the cap**

Find (line 528):
```ts
          const recent = isFolder ? s.recent : [path, ...s.recent.filter((p) => p !== path)].slice(0, 20);
```
Replace with:
```ts
          const recent = isFolder
            ? s.recent
            : [{ path, openedAt: Date.now() }, ...s.recent.filter((e) => e.path !== path)].slice(0, RECENT_CAP);
```

- [ ] **Step 8: Typecheck**

Run: `npm run typecheck`
Expected: FAILS at this point — `BookmarksPanel.tsx` still reads `recent` as `string[]` (calls
`.map`/`.includes` assuming strings). This is expected; Task 6 fixes it. Confirm the *only* errors
reported are inside `BookmarksPanel.tsx`, nothing else — that isolates the blast radius of this
type change to the one file we're about to rewrite next.

- [ ] **Step 9: Commit**

```bash
git add web/src/lib/store.ts
git commit -m "feat(store): recent becomes {path,openedAt}[], cap raised 20->200, migrate old data

Known-broken: BookmarksPanel.tsx still assumes recent: string[] — fixed in the next commit."
```

---

### Task 5: File Explorer quick filter (`FileTree.tsx`)

**Files:**
- Modify: `web/src/components/FileTree.tsx`

**Interfaces:**
- Consumes: `matchesQuery` from Task 1 (`web/src/lib/normalize.ts`).

- [ ] **Step 1: Import `useMemo` and `matchesQuery`**

Find (line 1-6):
```ts
import { useEffect, useRef, useState } from 'react';
import { useStore, type TreeSort } from '../lib/store';
import { api, type TreeNode } from '../lib/api';
import { findNode, pruneDescendants } from '../lib/tree';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';
```
Replace with:
```ts
import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, type TreeSort } from '../lib/store';
import { api, type TreeNode } from '../lib/api';
import { findNode, pruneDescendants } from '../lib/tree';
import { matchesQuery } from '../lib/normalize';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';
```

- [ ] **Step 2: Thread `visiblePaths` into `Node`'s props**

Find:
```ts
function Node({ node, depth }: { node: TreeNode; depth: number }) {
```
Replace with:
```ts
function Node({ node, depth, visiblePaths }: { node: TreeNode; depth: number; visiblePaths: Set<string> | null }) {
```

- [ ] **Step 3: Hide non-matching nodes, force-open matched ancestors**

Find (right after the hooks, before `isFolder`/`editing`/`isCut`):
```ts
  const isFolder = node.type === 'folder';
  const editing = renamingPath === node.path;
  const isCut = clipboard?.mode === 'cut' && clipboard.path === node.path;
```
Replace with:
```ts
  const isFolder = node.type === 'folder';
  const editing = renamingPath === node.path;
  const isCut = clipboard?.mode === 'cut' && clipboard.path === node.path;

  // Hide anything not in the filtered set (Node itself is only ever rendered for
  // paths that either matched the query or are an ancestor of a match).
  if (visiblePaths && !visiblePaths.has(node.path)) return null;
```

- [ ] **Step 4: Force folders open while filtering, without touching persisted `expanded`**

Find:
```ts
  const expanded = useStore((s) => s.expanded);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const open = expanded.includes(node.path); // persisted across reloads
```
Replace with:
```ts
  const expanded = useStore((s) => s.expanded);
  const toggleFolder = useStore((s) => s.toggleFolder);
  // While a filter is active every rendered folder is, by construction, an ancestor of a
  // match — force it open without touching persisted `expanded`, so clearing the filter
  // restores the exact prior expand/collapse state.
  const open = visiblePaths ? true : expanded.includes(node.path);
```

- [ ] **Step 5: Don't mutate `expanded` from a folder click while filtering**

Find (inside `onRowClick`):
```ts
    setSelected([node.path]);
    setSelectAnchor(node.path);
    if (isFolder) toggleFolder(node.path);
    else openFile(node.path);
```
Replace with:
```ts
    setSelected([node.path]);
    setSelectAnchor(node.path);
    if (isFolder) { if (!visiblePaths) toggleFolder(node.path); }
    else openFile(node.path);
```

- [ ] **Step 6: Pass `visiblePaths` down through the recursive folder-children render**

Find (folder branch, children map):
```ts
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((c) => (
              <Node key={c.path} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
```
Replace with:
```ts
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((c) => (
              <Node key={c.path} node={c} depth={depth + 1} visiblePaths={visiblePaths} />
            ))}
          </div>
        )}
```

- [ ] **Step 7: Compute `visiblePaths` in `FileTree()` and render the filter input**

Find (start of `export default function FileTree()`):
```ts
export default function FileTree() {
  const rawTree = useStore((s) => s.tree);
  const treeSort = useStore((s) => s.treeSort);
  const tree = rawTree ? sortTree(rawTree, treeSort) : rawTree;
  const loadTree = useStore((s) => s.loadTree);
```
Replace with:
```ts
export default function FileTree() {
  const rawTree = useStore((s) => s.tree);
  const treeSort = useStore((s) => s.treeSort);
  const tree = rawTree ? sortTree(rawTree, treeSort) : rawTree;
  const [filter, setFilter] = useState('');
  // null = no filter active (render everything, respect persisted `expanded`).
  // Set<string> = paths to render: matched files + every ancestor folder of a match.
  const visiblePaths = useMemo<Set<string> | null>(() => {
    if (!filter.trim()) return null;
    const visible = new Set<string>();
    if (!tree) return visible;
    const walk = (n: TreeNode): boolean => {
      let anyMatch = false;
      for (const c of n.children ?? []) {
        if (c.type === 'file') {
          if (matchesQuery(c.name, filter)) {
            visible.add(c.path);
            anyMatch = true;
          }
        } else if (walk(c)) {
          visible.add(c.path);
          anyMatch = true;
        }
      }
      return anyMatch;
    };
    walk(tree);
    return visible;
  }, [tree, filter]);
  const loadTree = useStore((s) => s.loadTree);
```

- [ ] **Step 8: Update the final return to show the filter box + wire `visiblePaths`**

Find (end of `FileTree()`):
```ts
  return (
    <div
      onDragOver={(e) => e.preventDefault()}
      onDrop={onRootDrop}
      onContextMenu={onRootContext}
      // Click on the empty area below the rows clears the selection.
      onClick={(e) => { if (e.target === e.currentTarget) setSelected([]); }}
      style={{ minHeight: '100%' }}
    >
      {tree.children.map((c) => (
        <Node key={c.path} node={c} depth={0} />
      ))}
    </div>
  );
}
```
Replace with:
```ts
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100%' }}>
      <div className="search-input-wrap" style={{ margin: '6px 8px' }}>
        <Icon name="search" size={14} className="search-lead" />
        <input
          className="search-input has-lead"
          placeholder="Filter files…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        {filter && (
          <button className="search-icon-btn" title="Clear" onClick={() => setFilter('')}>
            <Icon name="x" size={14} />
          </button>
        )}
      </div>
      {visiblePaths && visiblePaths.size === 0 ? (
        <div style={{ padding: '8px 12px', color: 'var(--text-faint)' }}>No matching files.</div>
      ) : (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onRootDrop}
          onContextMenu={onRootContext}
          // Click on the empty area below the rows clears the selection.
          onClick={(e) => { if (e.target === e.currentTarget) setSelected([]); }}
          style={{ minHeight: '100%', flex: 1 }}
        >
          {tree.children.map((c) => (
            <Node key={c.path} node={c} depth={0} visiblePaths={visiblePaths} />
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: PASS — this task doesn't touch `BookmarksPanel.tsx`, so its known-broken state from
Task 4 remains but is unaffected by this task's changes.

- [ ] **Step 10: Commit**

```bash
git add web/src/components/FileTree.tsx
git commit -m "feat(filetree): add diacritic-insensitive quick filter input

Still known-broken: BookmarksPanel.tsx (fixed next commit)."
```

---

### Task 6: Recent panel — 3 modes + range filter (`BookmarksPanel.tsx`)

**Files:**
- Modify: `web/src/components/BookmarksPanel.tsx` (full rewrite)
- Modify: `web/src/styles/obsidian.css:872` (append new rules)

**Interfaces:**
- Consumes: `flattenFiles` (Task 2), `filterAndSortRecent`/`RecentItem`/`RecentMode`/`RecentRange`
  (Task 3), `RecentEntry`/`store.recent` (Task 4).

- [ ] **Step 1: Add CSS for the mode/range toggle rows**

In `web/src/styles/obsidian.css`, find:
```css
.panel-item-actions > span:hover { color: var(--text-normal); background: var(--bg-modifier-hover); }
```
(line 872) and insert immediately after it:
```css

.recent-filter-row { display: flex; gap: 4px; padding: 2px 8px; flex-wrap: wrap; }
.recent-filter-btn {
  border: 0; background: transparent; color: var(--text-muted); cursor: pointer;
  padding: 3px 8px; border-radius: var(--radius-s); font-size: 12px;
}
.recent-filter-btn:hover { background: var(--bg-modifier-hover); color: var(--text-normal); }
.recent-filter-btn.active { color: var(--text-accent); background: var(--bg-modifier-hover); font-weight: 500; }
```

- [ ] **Step 2: Rewrite `BookmarksPanel.tsx`**

Replace the full contents of `web/src/components/BookmarksPanel.tsx` with:

```tsx
import { useMemo, useState } from 'react';
import { useStore, type ContextMenuItem } from '../lib/store';
import { flattenFiles } from '../lib/tree';
import { filterAndSortRecent, type RecentItem, type RecentMode, type RecentRange } from '../lib/recentList';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';

const MODES: RecentMode[] = ['opened', 'created', 'modified'];
const MODE_LABELS: Record<RecentMode, string> = { opened: 'Opened', created: 'Created', modified: 'Modified' };
const RANGES: RecentRange[] = ['week', 'month', '3months', 'all'];
const RANGE_LABELS: Record<RecentRange, string> = { week: '1 week', month: '1 month', '3months': '3 months', all: 'All' };

export default function BookmarksPanel() {
  const bookmarks = useStore((s) => s.bookmarks);
  const recentEntries = useStore((s) => s.recent);
  const tree = useStore((s) => s.tree);
  const openFile = useStore((s) => s.openFile);
  const openToSide = useStore((s) => s.openToSide);
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const removeRecent = useStore((s) => s.removeRecent);
  const revealInTree = useStore((s) => s.revealInTree);
  const setMovePath = useStore((s) => s.setMovePath);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const notify = useStore((s) => s.notify);

  const [mode, setMode] = useState<RecentMode>('opened');
  const [range, setRange] = useState<RecentRange>('week');

  const rawItems: RecentItem[] = useMemo(() => {
    if (mode === 'opened') return recentEntries.map((e) => ({ path: e.path, time: e.openedAt }));
    const field = mode === 'created' ? 'ctime' : 'mtime';
    return flattenFiles(tree).map((f) => ({ path: f.path, time: f[field] }));
  }, [mode, recentEntries, tree]);

  const items = useMemo(() => filterAndSortRecent(rawItems, range), [rawItems, range]);

  const name = (p: string) => p.split('/').pop()?.replace(/\.(md|markdown)$/, '') ?? p;

  const copyUrl = (p: string) => {
    navigator.clipboard?.writeText(`${location.origin}${pathToUrl(p)}`).catch(() => {});
    notify('URL copied');
  };

  // Drag a row onto a folder in the file tree to move the underlying file
  // (FileTree's onDrop reads this same `text/wo-path` payload).
  const onDragStart = (e: React.DragEvent, path: string) => {
    e.dataTransfer.setData('text/wo-path', path);
    e.dataTransfer.effectAllowed = 'move';
  };

  const showMenu = (e: React.MouseEvent, path: string, removableFromRecent: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    const isBookmarked = bookmarks.includes(path);
    const menuItems: ContextMenuItem[] = [
      { label: 'Open', icon: 'file-text', onClick: () => openFile(path) },
      { label: 'Open to the right', icon: 'columns', onClick: () => openToSide(path) },
      { label: '', separator: true },
      { label: 'Reveal file in navigation', icon: 'folder', onClick: () => revealInTree(path) },
      { label: 'Move file to…', icon: 'folder', onClick: () => setMovePath(path) },
      { label: isBookmarked ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => toggleBookmark(path) },
      ...(removableFromRecent
        ? [{ label: 'Remove from recent', icon: 'x', onClick: () => removeRecent(path) } as ContextMenuItem]
        : []),
      { label: 'Copy URL path', onClick: () => copyUrl(path) },
    ];
    openContextMenu({ x: e.clientX, y: e.clientY, items: menuItems });
  };

  const actionBtn = (e: React.MouseEvent, fn: () => void) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div>
      <div className="panel-title">Bookmarks</div>
      {bookmarks.length === 0 && <div className="panel-item">No bookmarks yet</div>}
      {bookmarks.map((b) => (
        <div
          key={b}
          className="panel-item"
          draggable
          onDragStart={(e) => onDragStart(e, b)}
          onClick={() => openFile(b)}
          onContextMenu={(e) => showMenu(e, b, false)}
          title={b}
        >
          <Icon name="bookmark" size={14} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(b)}</span>
          <span className="panel-item-actions">
            <span title="Move file to…" onClick={(e) => actionBtn(e, () => setMovePath(b))}>
              <Icon name="folder" size={13} />
            </span>
            <span title="Remove bookmark" onClick={(e) => actionBtn(e, () => toggleBookmark(b))}>
              <Icon name="x" size={13} />
            </span>
          </span>
        </div>
      ))}

      <div className="panel-title" style={{ marginTop: 8 }}>Recent</div>
      <div className="recent-filter-row">
        {MODES.map((m) => (
          <button key={m} className={`recent-filter-btn ${mode === m ? 'active' : ''}`} onClick={() => setMode(m)}>
            {MODE_LABELS[m]}
          </button>
        ))}
      </div>
      <div className="recent-filter-row">
        {RANGES.map((r) => (
          <button key={r} className={`recent-filter-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>
            {RANGE_LABELS[r]}
          </button>
        ))}
      </div>
      {items.length === 0 && <div className="panel-item">No notes in this range</div>}
      {items.map((it) => (
        <div
          key={it.path}
          className="panel-item"
          draggable
          onDragStart={(e) => onDragStart(e, it.path)}
          onClick={() => openFile(it.path)}
          onContextMenu={(e) => showMenu(e, it.path, mode === 'opened')}
          title={it.path}
        >
          <Icon name="clock" size={14} /> <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name(it.path)}</span>
          <span className="panel-item-actions">
            <span title="Move file to…" onClick={(e) => actionBtn(e, () => setMovePath(it.path))}>
              <Icon name="folder" size={13} />
            </span>
            {mode === 'opened' && (
              <span title="Remove from recent" onClick={(e) => actionBtn(e, () => removeRecent(it.path))}>
                <Icon name="x" size={13} />
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS — this is the file that was broken since Task 4; it should be clean now, and no
other file should report errors.

- [ ] **Step 4: Run the full unit test suite**

Run: `npm --workspace web run test`
Expected: PASS — all pre-existing tests (`headingFold`, `outlineNav`, etc.) plus the 3 new suites
from Tasks 1-3 (16 new tests total).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/BookmarksPanel.tsx web/src/styles/obsidian.css
git commit -m "feat(recent): Recent panel gets Opened/Created/Modified modes + range filter"
```

---

### Task 7: End-to-end verification against the real app (ad-hoc Playwright, not committed)

**Files:** none committed — this task runs a throwaway script from a scratch directory outside the
repo, matching how prior phases in this repo verified UI behavior (`IMPLEMENTATION_PLAN.md`
changelog: "Verify Playwright headless server thật" for Phase 30/31). No `.tsx` component tests
exist in this repo's convention (`web/vitest.config.ts` only includes `src/**/*.test.ts`), so this
is the appropriate verification tier for the two component changes in Tasks 5-6.

- [ ] **Step 1: Install a scratch Playwright**

A Chromium build is already cached locally (confirmed via `ls ~/Library/Caches/ms-playwright`), so
this only needs the JS package, not a browser download:

```bash
mkdir -p /tmp/wo-verify && cd /tmp/wo-verify && npm init -y --silent && npm install --no-save playwright --silent
```

- [ ] **Step 2: Write the verification script**

Create `/tmp/wo-verify/verify.mjs`:

```js
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const REPO = process.env.WO_REPO; // absolute path to the repo, passed in below
const DATA_DIR = mkdtempSync(path.join(tmpdir(), 'wo-data-'));
const VAULT = mkdtempSync(path.join(tmpdir(), 'wo-vault-'));

const now = Date.now();
const DAY_MS = 24 * 60 * 60 * 1000;
writeFileSync(path.join(VAULT, 'Đà Nẵng trip.md'), '# Đà Nẵng\n');
writeFileSync(path.join(VAULT, 'Other note.md'), '# Other\n');
writeFileSync(path.join(VAULT, 'Old note.md'), '# Old\n');
const oldTime = (now - 200 * DAY_MS) / 1000;
utimesSync(path.join(VAULT, 'Old note.md'), oldTime, oldTime);

function spawnNpm(args, extraEnv) {
  const p = spawn('npm', args, {
    cwd: REPO,
    env: { ...process.env, DATA_DIR, VAULT_PATH: VAULT, ...extraEnv },
    stdio: 'pipe',
  });
  p.stdout.on('data', (d) => process.stdout.write(`[${args.join(' ')}] ${d}`));
  p.stderr.on('data', (d) => process.stderr.write(`[${args.join(' ')}] ${d}`));
  return p;
}

async function waitFor(url, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok || r.status < 500) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

const server = spawnNpm(['--workspace', 'server', 'run', 'dev']);
const web = spawnNpm(['--workspace', 'web', 'run', 'dev']);

let browser;
let failures = 0;
const check = (label, cond) => {
  if (cond) console.log(`OK   ${label}`);
  else { console.error(`FAIL ${label}`); failures++; }
};

try {
  await waitFor('http://127.0.0.1:8787/healthz');
  await waitFor('http://127.0.0.1:5173');

  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:5173');

  // Login (fresh DATA_DIR => default password 123456).
  await page.fill('input[placeholder="Password"]', '123456');
  await page.click('button:has-text("Unlock")');

  // Forced default-password change screen.
  await page.waitForSelector('input[placeholder="New password"]', { timeout: 10000 });
  await page.fill('input[placeholder="New password"]', 'verify12345');
  await page.fill('input[placeholder="Confirm new password"]', 'verify12345');
  await page.click('button:has-text("Set password & continue")');

  // Main app loaded.
  await page.waitForSelector('.tree-row', { timeout: 10000 });

  // --- Part 1: filename quick filter ---
  await page.fill('input[placeholder="Filter files…"]', 'danang');
  await page.waitForTimeout(150);
  let rows = await page.locator('.tree-row .name').allTextContents();
  check('filter "danang" shows "Đà Nẵng trip"', rows.some((t) => t.includes('Đà Nẵng trip')));
  check('filter "danang" hides "Other note"', !rows.some((t) => t.includes('Other note')));

  await page.click('.search-input-wrap button[title="Clear"]');
  await page.waitForTimeout(150);
  rows = await page.locator('.tree-row .name').allTextContents();
  check('clearing filter restores all files', rows.some((t) => t.includes('Other note')));

  // --- Part 2: Recent panel, mode "Opened" ---
  await page.click('.tree-row:has-text("Đà Nẵng trip")');
  await page.waitForTimeout(150);
  await page.click('button[title="Bookmarks & recent"]');
  await page.waitForSelector('.recent-filter-row');
  let recentRows = await page.locator('.panel-item').allTextContents();
  check('Opened mode shows just-opened note', recentRows.some((t) => t.includes('Đà Nẵng trip')));

  // --- Part 2: Recent panel, mode "Modified" + range ---
  await page.click('.recent-filter-btn:has-text("Modified")');
  await page.click('.recent-filter-btn:has-text("All")');
  await page.waitForTimeout(150);
  recentRows = await page.locator('.panel-item').allTextContents();
  check('Modified + All shows the 200-day-old note', recentRows.some((t) => t.includes('Old note')));

  await page.click('.recent-filter-btn:has-text("1 week")');
  await page.waitForTimeout(150);
  recentRows = await page.locator('.panel-item').allTextContents();
  check('Modified + 1 week hides the 200-day-old note', !recentRows.some((t) => t.includes('Old note')));
  check('Modified + 1 week still shows a freshly-touched note', recentRows.some((t) => t.includes('trip') || t.includes('Other')));

  // --- Mode "Created": smoke check only (birthtime isn't settable via fs.utimes) ---
  await page.click('.recent-filter-btn:has-text("Created")');
  await page.waitForTimeout(150);
  check('Created mode renders without crashing', (await page.locator('.recent-filter-row').count()) === 2);
} finally {
  await browser?.close();
  server.kill();
  web.kill();
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
```

- [ ] **Step 3: Run it**

Run: `WO_REPO=$(pwd) node /tmp/wo-verify/verify.mjs` (run from the repo root)
Expected: `ALL CHECKS PASSED`, exit code 0. If any `FAIL` line prints, stop and fix the underlying
component (Task 5 or 6) — do not weaken the check.

- [ ] **Step 4: Clean up the scratch script**

```bash
rm -rf /tmp/wo-verify
```

(Temp `DATA_DIR`/`VAULT` dirs from the script are in the OS tmpdir and don't need manual cleanup.)

- [ ] **Step 5: No commit** — nothing in this task touches the repo.

---

### Task 8: Update PRD.md + IMPLEMENTATION_PLAN.md, final commit

**Files:**
- Modify: `PRD.md` (top changelog block, new `### FR-15` section)
- Modify: `IMPLEMENTATION_PLAN.md` (top "Cập nhật lần cuối" line, new `## Phase 32` section, new
  changelog entry)

This task only runs after Task 7 passes — per this project's `CLAUDE.md`, a plan item is only
checked off once it's verified working, not merely written.

- [ ] **Step 1: Bump the PRD version header**

In `PRD.md`, find (line 4):
```
> Phiên bản: 1.8 · Cập nhật: 2026-07-10 · Trạng thái: Draft
```
Replace with:
```
> Phiên bản: 1.9 · Cập nhật: 2026-07-14 · Trạng thái: Draft
> Changelog 1.9 (FR-15 — Quick filter tên file File Explorer + Recent 3-mode Opened/Created/
> Modified, theo yêu cầu người dùng): xem chi tiết ở §3 FR-15.
```

- [ ] **Step 2: Add the FR-15 section**

In `PRD.md`, find the end of the FR-14 section (right before the `---` that separates section 3
from section 4 "Yêu cầu phi chức năng"):
```
API mới: `GET/POST /api/html-preview`, `GET/POST /api/html-preview/{id}`, `POST
/api/html-preview/{id}/regenerate`, `PATCH/DELETE /api/html-preview/{id}`. Settings mới nhóm `llm`
(`provider`, `anthropicApiKey`, `openaiApiKey`, `openaiModel`, `templates[]`).

---

## 4. Yêu cầu phi chức năng (NFR)
```
Replace with:
```
API mới: `GET/POST /api/html-preview`, `GET/POST /api/html-preview/{id}`, `POST
/api/html-preview/{id}/regenerate`, `PATCH/DELETE /api/html-preview/{id}`. Settings mới nhóm `llm`
(`provider`, `anthropicApiKey`, `openaiApiKey`, `openaiModel`, `templates[]`).

### FR-15 · Quick filter tên file (File Explorer) & Recent theo Added/Modified
Mục tiêu: vault nhiều note theo thời gian khiến khó tìm note gần đây hoặc note theo tên. Hai cải
tiến độc lập cho sidebar trái:

- **Quick filter tên file** (panel File Explorer): ô nhập ở đầu cây thư mục, gõ vào lọc ngay cây
  file — ẩn file/folder không khớp, tự mở rộng folder chứa file khớp. So khớp chuẩn hóa: chữ
  thường, bỏ dấu tiếng Việt (kể cả đ/Đ), bỏ khoảng trắng, kiểu "chứa chuỗi con", chỉ so theo tên
  file (không theo path). Xóa ô nhập trả cây về đúng trạng thái mở/đóng trước đó.
- **Panel Recent 3 chế độ**: thay panel "Recent" (chỉ note vừa mở, tối đa 20) bằng 3 chế độ toggle
  — Opened (vừa mở, nay lưu tới 200 mục kèm thời điểm mở), Created (ngày tạo file, toàn vault),
  Modified (ngày sửa file, toàn vault). 4 nút lọc nhanh theo khoảng thời gian dùng chung cho cả 3
  chế độ: 1 week (mặc định) / 1 month / 3 months / All. "Remove from recent" trong menu chuột phải
  chỉ hiện ở chế độ Opened (2 chế độ kia tự suy ra từ filesystem, không xóa thủ công được).

Không đổi API server — cả hai tính năng dùng dữ liệu client đã có sẵn (cây file đã trả mtime/ctime
từ Phase 29; workspace state `recent` đổi định dạng nhưng vẫn qua cùng endpoint `/api/uistate`
không schema hoá phía server).

---

## 4. Yêu cầu phi chức năng (NFR)
```

- [ ] **Step 3: Update the "Cập nhật lần cuối" line in IMPLEMENTATION_PLAN.md**

Find (line 7):
```
Cập nhật lần cuối: 2026-07-14 (hardening bảo mật — CSP sandbox cho HTML Preview `/:id/raw`)
```
Replace with:
```
Cập nhật lần cuối: 2026-07-14 (Phase 32 — Quick filter tên file File Explorer + Recent 3-mode Opened/Created/Modified + filter khoảng thời gian)
```

- [ ] **Step 4: Add the Phase 32 section**

Find the end of Phase 31 (right before `### Nhật ký tiến độ`):
```
      cuối, collapse+jump tự mở section, Editing click-to-jump chạy. Typecheck + build + `vitest`
      (20/20) sạch.

### Nhật ký tiến độ
```
Replace with:
```
      cuối, collapse+jump tự mở section, Editing click-to-jump chạy. Typecheck + build + `vitest`
      (20/20) sạch.

## Phase 32 — Quick filter tên file + Recent theo Added/Modified — FR-15 (theo yêu cầu người dùng)
- [x] M32.1 `web/src/lib/normalize.ts` — `normalizeForFilter`/`matchesQuery` (bỏ dấu tiếng Việt +
      đ/Đ + khoảng trắng), Vitest.
- [x] M32.2 `web/src/lib/tree.ts` — `flattenFiles` (danh sách phẳng file toàn vault kèm mtime/
      ctime), Vitest.
- [x] M32.3 `web/src/lib/recentList.ts` — `filterAndSortRecent` theo range (week/month/3months/
      all), Vitest.
- [x] M32.4 `web/src/lib/store.ts` — `recent` đổi `string[]` → `RecentEntry[]` ({path, openedAt}),
      cap 200, migrate dữ liệu cũ.
- [x] M32.5 `FileTree.tsx` — ô filter tên file đầu panel, ẩn/hiện + auto-expand ancestor không đụng
      `expanded` persisted.
- [x] M32.6 `BookmarksPanel.tsx` — Recent 3 mode (Opened/Created/Modified) + 4 nút range, menu
      "Remove from recent" chỉ ở mode Opened.
- [x] M32.7 Verify Playwright server thật (vault tạm, login + set-pass): filter "danang" ra đúng
      note Đà Nẵng, ẩn note không khớp, xoá filter về bình thường; Recent mode Opened hiện note vừa
      mở; mode Modified + range 1 week ẩn note cũ >200 ngày, range All hiện lại. Typecheck +
      `vitest` sạch.

### Nhật ký tiến độ
- 2026-07-14 (Phase 32 — Quick filter tên file + Recent theo Added/Modified, theo yêu cầu người
  dùng): vault nhiều note khiến khó tìm note gần đây/theo tên. (1) File Explorer thêm ô filter tên
  file đầu panel (`web/src/lib/normalize.ts#matchesQuery`) — chuẩn hoá bỏ dấu tiếng Việt (kể cả
  đ/Đ) + khoảng trắng + lowercase trước khi so khớp substring, chỉ so theo filename; cây ẩn
  file/folder không khớp, tự mở ancestor chứa match mà **không đụng** `expanded` persisted (biến
  cục bộ `visiblePaths`, không gọi `toggleFolder` khi đang filter) nên xoá filter trả đúng trạng
  thái mở/đóng trước đó. (2) Panel "Recent" (trước chỉ 20 note vừa mở) đổi thành 3 chế độ toggle —
  Opened (nay lưu 200 mục kèm `openedAt`, migrate dữ liệu `string[]` cũ), Created/Modified (đọc
  thẳng mtime/ctime đã có sẵn trong cây từ Phase 29 qua `flattenFiles`, không cần API mới) — cộng 4
  nút lọc nhanh theo khoảng thời gian (1 week mặc định/1 month/3 months/All,
  `recentList.ts#filterAndSortRecent`) dùng chung cho cả 3 mode. "Remove from recent" trong menu
  chuột phải chỉ còn ở mode Opened. Verify Playwright server thật (vault tạm, login+set-pass, note
  mtime giả lập qua `fs.utimesSync`): gõ "danang" (không dấu) ra đúng note "Đà Nẵng…", ẩn note
  không khớp, xoá ô filter về nguyên trạng cây; mode Opened hiện note vừa mở; mode Modified + range
  1 week ẩn note 200 ngày tuổi, range All hiện lại. Typecheck + `vitest` sạch. *Giới hạn biết
  trước:* không kiểm định độc lập ctime khác mtime trong E2E (birthtime hệ điều hành không set tùy
  ý qua `fs.utimes` trên hầu hết filesystem) — mode Created chỉ verify không crash + render đúng
  cấu trúc, không verify thứ tự chính xác.
```

- [ ] **Step 5: Final typecheck + full unit test run**

```bash
npm run typecheck
npm --workspace web run test
```
Expected: both clean (docs-only changes in this task, so this should be identical to Task 6's
results — this step is a final safety net before the closing commit).

- [ ] **Step 6: Commit**

```bash
git add PRD.md IMPLEMENTATION_PLAN.md
git commit -m "docs: PRD FR-15 + IMPLEMENTATION_PLAN Phase 32 — quick filter + Recent 3-mode"
```

---

## Self-Review Notes

- **Spec coverage:** Part 1 (filename filter: normalize, live-filter, ancestor auto-expand,
  restore-on-clear) → Tasks 1, 5. Part 2 (Recent 3-mode, range filter, cap 200, migration, context
  menu) → Tasks 2, 3, 4, 6. Docs sync (project `CLAUDE.md` requirement) → Task 8. E2E verification
  (personal-project convention: real end-to-end test before done) → Task 7. No gaps found against
  `docs/superpowers/specs/2026-07-14-recent-panel-filters-design.md`.
- **Placeholder scan:** no TBD/TODO; every step has complete code; Task 7's script is a full,
  runnable script, not a description of one.
- **Type consistency:** `RecentEntry` (Task 4) → consumed as `store.recent: RecentEntry[]` in Task
  6. `RecentItem`/`RecentMode`/`RecentRange`/`filterAndSortRecent` (Task 3) → consumed identically
  in Task 6. `FlatFile`/`flattenFiles` (Task 2) → consumed in Task 6 via `f[field]` where
  `field: 'ctime' | 'mtime'`, matching `FlatFile`'s field names exactly. `matchesQuery` (Task 1) →
  consumed with the same 2-arg signature in Task 5.
