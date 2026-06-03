import { create } from 'zustand';
import { api, type TreeNode } from './api';

export type ViewMode = 'live' | 'source' | 'reading';

export interface Tab {
  path: string;
  title: string;
}

export interface ContextMenuItem {
  label: string;
  danger?: boolean;
  separator?: boolean;
  icon?: string;
  onClick?: () => void;
  submenu?: ContextMenuItem[];
}

export interface ContextMenuState {
  x: number;
  y: number;
  items: ContextMenuItem[];
}

const BM_KEY = 'webobsidian:bookmarks';
function loadBookmarks(): string[] {
  try {
    return JSON.parse(localStorage.getItem(BM_KEY) || '[]');
  } catch {
    return [];
  }
}

interface AppState {
  authed: boolean;
  setAuthed: (v: boolean) => void;

  tree: TreeNode | null;
  loadTree: () => Promise<void>;

  tabs: Tab[];
  activePath: string | null;
  content: string;
  dirty: boolean;
  viewMode: ViewMode;
  setViewMode: (m: ViewMode) => void;

  // split pane (open to the side)
  splitPath: string | null;
  splitContent: string;
  openToSide: (path: string) => Promise<void>;
  closeSplit: () => void;

  // recent + bookmarks
  recent: string[];
  bookmarks: string[];
  toggleBookmark: (path: string) => void;

  leftPanel: 'files' | 'search' | 'tags' | 'bookmarks';
  setLeftPanel: (p: 'files' | 'search' | 'tags' | 'bookmarks') => void;
  leftOpen: boolean;
  rightOpen: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;

  paletteOpen: boolean;
  paletteMode: 'all' | 'commands' | 'files';
  setPalette: (v: boolean, mode?: 'all' | 'commands' | 'files') => void;
  settingsOpen: boolean;
  setSettings: (v: boolean) => void;
  graphOpen: boolean;
  setGraph: (v: boolean) => void;

  contextMenu: ContextMenuState | null;
  openContextMenu: (m: ContextMenuState) => void;
  closeContextMenu: () => void;

  toast: string;
  notify: (msg: string) => void;

  openFile: (path: string) => Promise<void>;
  openWikilink: (target: string) => Promise<void>;
  closeTab: (path: string) => void;
  setContent: (c: string) => void;
  save: () => Promise<void>;
  createNote: (path: string, body?: string) => Promise<void>;
  openDailyNote: () => Promise<void>;
}

const TEXT_RE = /\.(md|markdown|txt|json|csv|canvas|css|js|ya?ml)$/i;

export const useStore = create<AppState>((set, get) => ({
  authed: false,
  setAuthed: (v) => set({ authed: v }),

  tree: null,
  loadTree: async () => {
    const tree = await api.tree();
    set({ tree });
  },

  tabs: [],
  activePath: null,
  content: '',
  dirty: false,
  viewMode: 'live',
  setViewMode: (m) => set({ viewMode: m }),

  splitPath: null,
  splitContent: '',
  openToSide: async (path) => {
    if (!TEXT_RE.test(path)) return;
    const r = await api.read(path);
    set({ splitPath: path, splitContent: typeof r === 'string' ? r : r.content });
  },
  closeSplit: () => set({ splitPath: null, splitContent: '' }),

  recent: [],
  bookmarks: loadBookmarks(),
  toggleBookmark: (path) =>
    set((s) => {
      const has = s.bookmarks.includes(path);
      const bookmarks = has ? s.bookmarks.filter((p) => p !== path) : [...s.bookmarks, path];
      localStorage.setItem(BM_KEY, JSON.stringify(bookmarks));
      return { bookmarks };
    }),

  leftPanel: 'files',
  setLeftPanel: (p) => set({ leftPanel: p, leftOpen: true }),
  leftOpen: true,
  rightOpen: true,
  toggleLeft: () => set((s) => ({ leftOpen: !s.leftOpen })),
  toggleRight: () => set((s) => ({ rightOpen: !s.rightOpen })),

  paletteOpen: false,
  paletteMode: 'all',
  setPalette: (v, mode = 'all') => set({ paletteOpen: v, paletteMode: mode }),
  settingsOpen: false,
  setSettings: (v) => set({ settingsOpen: v }),
  graphOpen: false,
  setGraph: (v) => set({ graphOpen: v }),

  contextMenu: null,
  openContextMenu: (m) => set({ contextMenu: m }),
  closeContextMenu: () => set({ contextMenu: null }),

  toast: '',
  notify: (msg) => {
    set({ toast: msg });
    window.setTimeout(() => set((s) => (s.toast === msg ? { toast: '' } : {})), 2500);
  },

  openFile: async (path) => {
    if (get().dirty) await get().save();
    let content = '';
    if (TEXT_RE.test(path)) {
      const r = await api.read(path);
      content = typeof r === 'string' ? r : r.content;
    }
    const title = path.split('/').pop() ?? path;
    set((s) => {
      const tabs = s.tabs.find((t) => t.path === path) ? s.tabs : [...s.tabs, { path, title }];
      const recent = [path, ...s.recent.filter((p) => p !== path)].slice(0, 20);
      return { tabs, activePath: path, content, dirty: false, recent };
    });
  },

  openWikilink: async (target) => {
    try {
      const { path } = await api.resolve(target);
      if (path) await get().openFile(path);
      else {
        const newPath = target.endsWith('.md') ? target : `${target}.md`;
        await get().createNote(newPath, `# ${target.replace(/\.md$/, '')}\n`);
      }
    } catch {
      /* ignore */
    }
  },

  closeTab: (path) =>
    set((s) => {
      const tabs = s.tabs.filter((t) => t.path !== path);
      const activePath = s.activePath === path ? (tabs.at(-1)?.path ?? null) : s.activePath;
      return { tabs, activePath };
    }),

  setContent: (c) => set({ content: c, dirty: true }),

  save: async () => {
    const { activePath, content, dirty } = get();
    if (!activePath || !dirty) return;
    if (!TEXT_RE.test(activePath)) return;
    await api.write(activePath, content);
    set({ dirty: false });
  },

  createNote: async (path, body) => {
    await api.write(path, body ?? '');
    await get().loadTree();
    await get().openFile(path);
  },

  openDailyNote: async () => {
    const d = new Date();
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`;
    const path = `Daily/${iso}.md`;
    try {
      const { path: existing } = await api.resolve(iso);
      if (existing) {
        await get().openFile(existing);
        return;
      }
    } catch {
      /* none */
    }
    await get().createNote(path, `# ${iso}\n\n`);
    get().notify(`Daily note ${iso} ready`);
  },
}));
