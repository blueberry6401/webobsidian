# Inline Title Rename (Live Preview) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the inline title (filename) shown above a note's content in Live Preview click-to-edit — editing it renames the underlying file, while keeping the same tab open and pointed at the new path.

**Architecture:** The inline title is already rendered as a CodeMirror 6 block widget (`TitleWidget` in `web/src/lib/livePreview.ts`), reused for both Live Preview and Reading (the app runs one CodeMirror instance for all three view modes, toggling `readOnly`). We turn that widget's DOM into a `contenteditable` element only when not read-only (mirrors the existing `TableWidget`/Properties-widget pattern in the same file), and wire its commit action through the file's established "register a callback" convention (`setLivePreviewXHandler`) into a new Zustand store action `renameActiveNote`, which calls the existing `PATCH /api/files/rename` endpoint and updates `tabs`/`activePath` in place (no `closeTab`, no `openFile` refetch). No server or API changes — the rename endpoint already exists and already handles the QMD index update.

**Tech Stack:** React, Zustand (`web/src/lib/store.ts`), CodeMirror 6 (`web/src/lib/livePreview.ts`), existing `api.rename` (`web/src/lib/api.ts`).

## Global Constraints

- Only editable in **Live Preview**. Source mode never showed the title widget (unchanged). Reading mode stays read-only (whole pane is `readOnly`).
- Extension (`.md`/`.markdown`) is preserved automatically — never shown or editable in the title box.
- `/` characters typed into the title are stripped — this box renames in place, it does not move the file to another folder.
- Empty title or unchanged title → no-op (no API call), box reverts to the current name.
- Renaming the active file must **not** close its tab — tab and `activePath` switch to the new path in place; the URL follows automatically via the existing `urlsync.ts` store subscription (no changes needed there).
- No new dependencies. No test framework exists in `web/` (no `*.test.*` files, no test script in `web/package.json`) — verification is `npm run typecheck` + manual browser walkthrough per each task, consistent with the rest of this codebase.
- Known accepted limitation (do not fix here): same-name collision on rename silently overwrites the target — this is pre-existing behavior of `vault.rename`/`api.rename` shared by the Files-panel rename too, out of scope for this plan.

---

### Task 1: Editable `TitleWidget` in `livePreview.ts`

**Files:**
- Modify: `web/src/lib/livePreview.ts:25-28` (add rename-handler registration, same convention as `setLivePreviewLinkHandler`)
- Modify: `web/src/lib/livePreview.ts:2492-2540` (replace `TitleWidget` class, `buildInlineTitle`, `inlineTitleField`)
- Modify: `web/src/lib/livePreview.ts:2662-2670` (add editable-state CSS in `livePreviewTheme`)

**Interfaces:**
- Consumes: existing `livePreviewState`, `livePreviewReadonly`, `noteTitleField`, `setLivePreviewEnabled`, `setLivePreviewReadonly`, `WidgetType`, `Decoration`, `DecorationSet`, `EditorState`, `StateField`, `EditorView` (all already imported in this file).
- Produces: `export function setLivePreviewRenameHandler(fn: (newTitle: string) => void): void` — the app wires this in `Editor.tsx` (Task 3) to call the new store action. `noteTitleField`/`setNoteTitle`/`inlineTitleField` keep their existing exported names and types (Task 3 already imports them; no signature changes).

- [ ] **Step 1: Add the rename-handler registration**

In `web/src/lib/livePreview.ts`, right after the existing link-handler block (lines 25-28):

```ts
let openLink: (target: string) => void = () => {};
export function setLivePreviewLinkHandler(fn: (target: string) => void) {
  openLink = fn;
}

let renameActiveTitle: (newTitle: string) => void = () => {};
export function setLivePreviewRenameHandler(fn: (newTitle: string) => void) {
  renameActiveTitle = fn;
}
```

- [ ] **Step 2: Replace `TitleWidget` / `buildInlineTitle` / `inlineTitleField`**

Replace the current block (lines 2492-2540):

```ts
class TitleWidget extends WidgetType {
  constructor(readonly title: string) {
    super();
  }
  eq(o: TitleWidget) {
    return o.title === this.title;
  }
  toDOM() {
    const d = document.createElement('div');
    d.className = 'cm-inline-title';
    d.textContent = this.title;
    return d;
  }
}

export const setNoteTitle = StateEffect.define<string>();

export const noteTitleField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNoteTitle)) return e.value;
    return value;
  },
});

function buildInlineTitle(state: EditorState): DecorationSet {
  if (!state.field(livePreviewState, false)) return Decoration.none;
  const title = state.field(noteTitleField, false) ?? '';
  if (!title) return Decoration.none;
  // Skip when the note already opens with an H1 equal to the title — the Trilium
  // export repeats the title as a heading, and Obsidian would otherwise show it twice.
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 2000));
  const noFm = head.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  const firstLine = noFm.split(/\r?\n/).find((l) => l.trim() !== '');
  const h1 = firstLine?.match(/^#\s+(.+?)\s*$/);
  if (h1 && h1[1].trim().toLowerCase() === title.trim().toLowerCase()) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new TitleWidget(title), block: true, side: -1 }).range(0)]);
}

export const inlineTitleField = StateField.define<DecorationSet>({
  create: (state) => buildInlineTitle(state),
  update(value, tr) {
    if (tr.docChanged || tr.effects.some((e) => e.is(setNoteTitle) || e.is(setLivePreviewEnabled))) {
      return buildInlineTitle(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

with:

```ts
class TitleWidget extends WidgetType {
  constructor(readonly title: string, readonly ro: boolean) {
    super();
  }
  eq(o: TitleWidget) {
    return o.title === this.title && o.ro === this.ro;
  }
  ignoreEvent() {
    // We own all interaction (contenteditable + commit); keep events from reaching CM.
    return true;
  }
  toDOM() {
    const d = document.createElement('div');
    d.className = this.ro ? 'cm-inline-title' : 'cm-inline-title cm-inline-title-editable';
    d.textContent = this.title;
    if (this.ro) return d;
    d.setAttribute('contenteditable', 'true');
    d.spellcheck = false;
    const original = this.title;
    let cancelled = false;
    const commit = () => {
      if (cancelled) {
        cancelled = false;
        return;
      }
      // `/` renames-in-place only, never moves the file; collapse any pasted newlines.
      const next = d.innerText.replace(/[/\\\n]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!next || next === original) {
        d.textContent = original;
        return;
      }
      renameActiveTitle(next);
    };
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        d.blur();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        cancelled = true;
        d.textContent = original;
        d.blur();
      }
    });
    d.addEventListener('blur', commit);
    return d;
  }
}

export const setNoteTitle = StateEffect.define<string>();

export const noteTitleField = StateField.define<string>({
  create: () => '',
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setNoteTitle)) return e.value;
    return value;
  },
});

function buildInlineTitle(state: EditorState): DecorationSet {
  if (!state.field(livePreviewState, false)) return Decoration.none;
  const title = state.field(noteTitleField, false) ?? '';
  if (!title) return Decoration.none;
  // Skip when the note already opens with an H1 equal to the title — the Trilium
  // export repeats the title as a heading, and Obsidian would otherwise show it twice.
  const head = state.doc.sliceString(0, Math.min(state.doc.length, 2000));
  const noFm = head.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '');
  const firstLine = noFm.split(/\r?\n/).find((l) => l.trim() !== '');
  const h1 = firstLine?.match(/^#\s+(.+?)\s*$/);
  if (h1 && h1[1].trim().toLowerCase() === title.trim().toLowerCase()) return Decoration.none;
  const ro = state.field(livePreviewReadonly, false) ?? false;
  return Decoration.set([Decoration.widget({ widget: new TitleWidget(title, ro), block: true, side: -1 }).range(0)]);
}

export const inlineTitleField = StateField.define<DecorationSet>({
  create: (state) => buildInlineTitle(state),
  update(value, tr) {
    if (
      tr.docChanged ||
      tr.effects.some((e) => e.is(setNoteTitle) || e.is(setLivePreviewEnabled) || e.is(setLivePreviewReadonly))
    ) {
      return buildInlineTitle(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});
```

- [ ] **Step 3: Add the editable-state theme rules**

In the same file, inside `export const livePreviewTheme = EditorView.baseTheme({ ... })`, right after the existing `.cm-inline-title` block (~line 2662-2670):

```ts
  '.cm-inline-title': {
    fontSize: 'var(--h1-size)',
    fontWeight: 'var(--h1-weight)',
    lineHeight: 'var(--line-height-tight)',
    letterSpacing: '-0.015em',
    color: 'var(--text-normal)',
    margin: '0 0 0.5em',
    padding: '0',
  },
  '.cm-inline-title-editable': { cursor: 'text', outline: 'none', borderRadius: '4px' },
  '.cm-inline-title-editable:hover': { background: 'var(--bg-modifier-hover)' },
  '.cm-inline-title-editable:focus': {
    background: 'var(--bg-primary)',
    boxShadow: 'inset 0 0 0 1px var(--interactive-accent)',
  },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `web` workspace (this is a frontend-only change; `server` workspace is untouched).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/livePreview.ts
git commit -m "feat(editor): make Live Preview inline title contenteditable"
```

---

### Task 2: `renameActiveNote` store action

**Files:**
- Modify: `web/src/lib/store.ts:194` (interface — add method signature after `closeTab`)
- Modify: `web/src/lib/store.ts:514-520` (implementation — add action after `closeTab`)

**Interfaces:**
- Consumes: `get().activePath: string | null`, `get().notify(msg: string, ms?: number): void`, `get().loadTree(): Promise<void>`, `api.rename(from: string, to: string): Promise<{ ok: true }>` (`web/src/lib/api.ts:116-117`, unchanged), `Tab` type (`{ path: string; title: string }`, `web/src/lib/store.ts:18-21`, unchanged).
- Produces: `renameActiveNote: (newTitle: string) => Promise<void>` on the store — Task 3 calls it as `useStore.getState().renameActiveNote(newTitle)`.

- [ ] **Step 1: Add the interface signature**

In `web/src/lib/store.ts`, change:

```ts
  openFile: (path: string) => Promise<void>;
  openWikilink: (target: string) => Promise<void>;
  closeTab: (path: string) => void;
  setContent: (c: string) => void;
```

to:

```ts
  openFile: (path: string) => Promise<void>;
  openWikilink: (target: string) => Promise<void>;
  closeTab: (path: string) => void;
  /**
   * Rename the active note from its inline title: same folder, extension kept,
   * `/` stripped from the new name. Unlike the Files-panel rename, this does NOT
   * close the tab — the active tab and URL switch to the new path in place.
   */
  renameActiveNote: (newTitle: string) => Promise<void>;
  setContent: (c: string) => void;
```

- [ ] **Step 2: Add the implementation**

In the same file, change:

```ts
      closeTab: (path) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.path !== path);
          const wasActive = s.activePath === path;
          const activePath = wasActive ? (tabs.at(-1)?.path ?? null) : s.activePath;
          return { tabs, activePath, ...(wasActive ? { content: '', dirty: false } : {}) };
        }),

      setContent: (c) => set({ content: c, dirty: true }),
```

to:

```ts
      closeTab: (path) =>
        set((s) => {
          const tabs = s.tabs.filter((t) => t.path !== path);
          const wasActive = s.activePath === path;
          const activePath = wasActive ? (tabs.at(-1)?.path ?? null) : s.activePath;
          return { tabs, activePath, ...(wasActive ? { content: '', dirty: false } : {}) };
        }),

      renameActiveNote: async (newTitle) => {
        const { activePath } = get();
        if (!activePath) return;
        const slash = activePath.lastIndexOf('/');
        const dir = slash < 0 ? '' : activePath.slice(0, slash);
        const ext = activePath.match(/\.(md|markdown)$/i)?.[0] ?? '.md';
        const clean = newTitle.replace(/\//g, '').trim();
        if (!clean) return;
        const name = `${clean}${ext}`;
        const to = dir ? `${dir}/${name}` : name;
        if (to === activePath) return;
        try {
          await api.rename(activePath, to);
        } catch (e: any) {
          get().notify(e?.message ?? 'Rename failed');
          return;
        }
        set((s) => ({
          tabs: s.tabs.map((t) => (t.path === activePath ? { path: to, title: name } : t)),
          activePath: to,
        }));
        await get().loadTree();
      },

      setContent: (c) => set({ content: c, dirty: true }),
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `web` workspace.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/store.ts
git commit -m "feat(store): add renameActiveNote for inline-title rename"
```

---

### Task 3: Wire the rename handler in `Editor.tsx`

**Files:**
- Modify: `web/src/components/Editor.tsx:14-40` (import list — add `setLivePreviewRenameHandler`)
- Modify: `web/src/components/Editor.tsx:67-69` (add a registration effect)

**Interfaces:**
- Consumes: `setLivePreviewRenameHandler(fn: (newTitle: string) => void): void` (Task 1), `useStore.getState().renameActiveNote(newTitle: string): Promise<void>` (Task 2).
- Produces: nothing new consumed by later tasks — this is the last wiring point.

- [ ] **Step 1: Import the setter**

In `web/src/components/Editor.tsx`, change:

```ts
  setLivePreviewPropertyTypeSetter,
  setLivePreviewTagProvider,
  setNoteTitle,
} from '../lib/livePreview';
```

to:

```ts
  setLivePreviewPropertyTypeSetter,
  setLivePreviewRenameHandler,
  setLivePreviewTagProvider,
  setNoteTitle,
} from '../lib/livePreview';
```

- [ ] **Step 2: Register the handler**

Change:

```ts
  useEffect(() => {
    setLivePreviewLinkHandler(openWikilink);
  }, [openWikilink]);

  useEffect(() => {
    setLivePreviewMenuHandler(openContextMenu);
```

to:

```ts
  useEffect(() => {
    setLivePreviewLinkHandler(openWikilink);
  }, [openWikilink]);

  useEffect(() => {
    setLivePreviewRenameHandler((newTitle) => {
      void useStore.getState().renameActiveNote(newTitle);
    });
  }, []);

  useEffect(() => {
    setLivePreviewMenuHandler(openContextMenu);
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors in `web` workspace.

- [ ] **Step 4: Commit**

```bash
git add web/src/components/Editor.tsx
git commit -m "feat(editor): wire inline-title rename handler into the store"
```

---

### Task 4: Manual end-to-end verification

**Files:** none (verification only — no test framework exists in `web/`, per Global Constraints).

- [ ] **Step 1: Start the app**

Run: `npm run dev`
Expected: server + web dev servers start; open the printed local URL in a browser, log in.

- [ ] **Step 2: Basic rename — tab stays open**

Open any `.md` note in Live Preview. Click the title text at the top of the note. Clear it and type a new name, press **Enter**.
Expected: the tab keeps showing the note (no empty-state, no jump to another tab); the tab label and the browser URL now reflect the new name; the Files sidebar shows the renamed file, not a duplicate.

- [ ] **Step 3: Blur commits too**

Click the title, change the text, then click into the note body instead of pressing Enter.
Expected: same rename happens on blur (not only on Enter).

- [ ] **Step 4: Escape cancels**

Click the title, type something different, press **Escape**.
Expected: title reverts to the original name; no rename call happens (Files sidebar / tab / URL unchanged).

- [ ] **Step 5: Empty / unchanged input is a no-op**

Click the title, delete all the text, click away. Then click the title again, click away without changing anything.
Expected: in both cases the original filename is restored / kept — no rename call, no error toast.

- [ ] **Step 6: `/` is stripped, extension is never shown**

Click the title, type `foo/bar`, press Enter.
Expected: the file is renamed to `foobar.md` (or `foobar.markdown`, matching the original extension) — not moved into a `foo/` subfolder. The title box never showed `.md` at any point.

- [ ] **Step 7: Source and Reading mode stay non-editable**

Switch the same note to Source mode — confirm there is no separate title box to click (unchanged from current behavior). Switch to Reading mode — click where the title text is.
Expected: nothing becomes editable; no contenteditable caret appears.

- [ ] **Step 8: Update IMPLEMENTATION_PLAN.md**

Flip `M28.1`–`M28.4` in `IMPLEMENTATION_PLAN.md` from `[~]`/`[ ]` to `[x]`, update the "Cập nhật lần cuối" line and add a progress-log entry summarizing the verified behavior (per this project's `CLAUDE.md` rule: a checkbox is only `[x]` once it's been verified working, not just written).

- [ ] **Step 9: Commit the plan-tracking update**

```bash
git add IMPLEMENTATION_PLAN.md
git commit -m "docs: mark Phase 28 inline-title rename as verified"
```
