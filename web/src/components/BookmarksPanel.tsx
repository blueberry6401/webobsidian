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
