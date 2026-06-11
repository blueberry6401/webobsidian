import { useEffect, useRef, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type TreeNode } from '../lib/api';
import { pathToUrl } from '../lib/urlsync';
import Icon from './Icon';

/** Inline rename box shown in place of a tree row's name (Obsidian-style). */
function RenameInput({ node, onDone }: { node: TreeNode; onDone: () => void }) {
  const loadTree = useStore((s) => s.loadTree);
  const closeTab = useStore((s) => s.closeTab);
  const notify = useStore((s) => s.notify);
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    // Select the name but not the extension, like Obsidian.
    const dot = node.type === 'file' ? node.name.lastIndexOf('.') : -1;
    el.setSelectionRange(0, dot > 0 ? dot : node.name.length);
  }, [node.name, node.type]);

  const finish = (commit: boolean) => async () => {
    if (done.current) return;
    done.current = true;
    const name = (ref.current?.value ?? '').trim();
    onDone();
    if (!commit || !name || name === node.name) return;
    const dir = parentDir(node.path);
    const to = dir ? `${dir}/${name}` : name;
    if (to === node.path) return;
    try {
      await api.rename(node.path, to);
      closeTab(node.path);
    } catch (e: any) {
      notify(e?.message ?? 'Rename failed');
    }
    await loadTree();
  };

  return (
    <input
      ref={ref}
      className="tree-rename"
      defaultValue={node.name}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); void finish(true)(); }
        else if (e.key === 'Escape') { e.preventDefault(); void finish(false)(); }
      }}
      onBlur={finish(true)}
    />
  );
}

function fileIcon(node: TreeNode): string | null {
  const ext = node.ext ?? '';
  if (/\.(md|markdown)$/.test(ext)) return null; // markdown: text only, like Obsidian
  if (/\.(png|jpe?g|gif|svg|webp)$/.test(ext)) return 'image';
  if (ext === '.pdf') return 'file-pdf';
  return 'paperclip';
}

function parentDir(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

function Node({ node, depth }: { node: TreeNode; depth: number }) {
  const expanded = useStore((s) => s.expanded);
  const toggleFolder = useStore((s) => s.toggleFolder);
  const open = expanded.includes(node.path); // persisted across reloads
  const [dropping, setDropping] = useState(false);
  const activePath = useStore((s) => s.activePath);
  const openFile = useStore((s) => s.openFile);
  const openToSide = useStore((s) => s.openToSide);
  const loadTree = useStore((s) => s.loadTree);
  const closeTab = useStore((s) => s.closeTab);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setMovePath = useStore((s) => s.setMovePath);
  const newNote = useStore((s) => s.newNote);
  const newFolder = useStore((s) => s.newFolder);
  const renamingPath = useStore((s) => s.renamingPath);
  const setRenamingPath = useStore((s) => s.setRenamingPath);
  const toggleBookmark = useStore((s) => s.toggleBookmark);
  const bookmarks = useStore((s) => s.bookmarks);
  const notify = useStore((s) => s.notify);
  const setShareDialog = useStore((s) => s.setShareDialog);
  const shares = useStore((s) => s.shares);

  const isFolder = node.type === 'folder';
  const editing = renamingPath === node.path;

  const doRename = () => setRenamingPath(node.path);
  const doDelete = async () => {
    if (confirm(`Move "${node.name}" to trash?`)) {
      await api.remove(node.path);
      closeTab(node.path);
      await loadTree();
      notify('Moved to trash');
    }
  };

  const doCopy = async () => {
    const r = await api.read(node.path).catch(() => null);
    if (!r) return;
    const content = typeof r === 'string' ? r : r.content;
    const dot = node.path.lastIndexOf('.');
    const copyPath = dot > 0 ? `${node.path.slice(0, dot)} copy${node.path.slice(dot)}` : `${node.path} copy`;
    await api.write(copyPath, content);
    await loadTree();
    notify('Made a copy');
  };
  const doMove = () => setMovePath(node.path);
  const copyPath = () => {
    navigator.clipboard?.writeText(node.path).catch(() => {});
    notify('Path copied');
  };
  const copyUrl = () => {
    navigator.clipboard?.writeText(`${location.origin}${pathToUrl(node.path)}`).catch(() => {});
    notify('URL copied');
  };

  const onContext = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const items = isFolder
      ? [
          { label: 'New note', onClick: () => newNote(node.path) },
          { label: 'New folder', onClick: () => newFolder(node.path) },
          { label: '', separator: true },
          { label: 'Rename…', onClick: doRename },
          { label: 'Move folder to…', onClick: doMove },
          { label: 'Copy path', onClick: copyPath },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ]
      : [
          { label: 'Open', onClick: () => openFile(node.path) },
          { label: 'Open to the right', onClick: () => openToSide(node.path) },
          { label: '', separator: true },
          { label: bookmarks.includes(node.path) ? 'Remove bookmark' : 'Bookmark', onClick: () => toggleBookmark(node.path) },
          ...(/\.(md|markdown)$/i.test(node.path)
            ? [{ label: 'Share…', icon: 'globe', onClick: () => setShareDialog(node.path) }]
            : []),
          { label: 'Make a copy', onClick: doCopy },
          { label: 'Rename…', onClick: doRename },
          { label: 'Move file to…', onClick: doMove },
          { label: 'Copy URL path', onClick: copyUrl },
          { label: '', separator: true },
          { label: 'Delete', danger: true, onClick: doDelete },
        ];
    openContextMenu({ x: e.clientX, y: e.clientY, items });
  };

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('text/wo-path', node.path);
    e.dataTransfer.effectAllowed = 'move';
  };
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    const from = e.dataTransfer.getData('text/wo-path');
    const targetDir = isFolder ? node.path : parentDir(node.path);
    if (!from || from === targetDir) return;
    const base = from.split('/').pop()!;
    const to = targetDir ? `${targetDir}/${base}` : base;
    if (to === from) return;
    await api.rename(from, to).catch((err) => notify(err.message));
    closeTab(from);
    await loadTree();
  };

  if (isFolder) {
    return (
      <div className="tree-item">
        <div
          className={`tree-row folder ${dropping ? 'drop-target' : ''}`}
          onClick={() => toggleFolder(node.path)}
          onContextMenu={onContext}
          onDragOver={(e) => { e.preventDefault(); setDropping(true); }}
          onDragLeave={() => setDropping(false)}
          onDrop={onDrop}
        >
          <span className="twisty">
            <Icon name={open ? 'chevron-down' : 'chevron-right'} size={14} />
          </span>
          {editing ? (
            <RenameInput node={node} onDone={() => setRenamingPath(null)} />
          ) : (
            <span className="name">{node.name}</span>
          )}
        </div>
        {open && (
          <div className="tree-children">
            {(node.children ?? []).map((c) => (
              <Node key={c.path} node={c} depth={depth + 1} />
            ))}
          </div>
        )}
      </div>
    );
  }

  const fi = fileIcon(node);
  return (
    <div className="tree-item">
      <div
        className={`tree-row ${activePath === node.path ? 'active' : ''}`}
        data-path={node.path}
        draggable
        onDragStart={onDragStart}
        onClick={() => openFile(node.path)}
        onContextMenu={onContext}
        title={node.path}
      >
        <span className="twisty leaf" />
        {fi && <span className="twisty"><Icon name={fi} size={14} /></span>}
        {editing ? (
          <RenameInput node={node} onDone={() => setRenamingPath(null)} />
        ) : (
          <span className="name">{node.name.replace(/\.(md|markdown)$/, '')}</span>
        )}
        {shares.some((s) => s.path === node.path && s.enabled) && (
          <Icon name="globe" size={12} className="share-globe" />
        )}
        {bookmarks.includes(node.path) && <Icon name="bookmark" size={12} className="bm-star" />}
      </div>
    </div>
  );
}

export default function FileTree() {
  const tree = useStore((s) => s.tree);
  const loadTree = useStore((s) => s.loadTree);
  const notify = useStore((s) => s.notify);

  // "Reveal file in navigation": scroll + flash the row once its folders expand.
  useEffect(() => {
    const onReveal = (e: Event) => {
      const path = (e as CustomEvent<{ path: string }>).detail?.path;
      if (!path) return;
      requestAnimationFrame(() => {
        const el = document.querySelector<HTMLElement>(`.tree-row[data-path="${CSS.escape(path)}"]`);
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.classList.add('reveal-flash');
        window.setTimeout(() => el.classList.remove('reveal-flash'), 1200);
      });
    };
    window.addEventListener('wo-reveal-file', onReveal);
    return () => window.removeEventListener('wo-reveal-file', onReveal);
  }, []);

  const onRootDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    const from = e.dataTransfer.getData('text/wo-path');
    if (!from || !from.includes('/')) return;
    const base = from.split('/').pop()!;
    await api.rename(from, base).catch((err) => notify(err.message));
    await loadTree();
  };

  if (!tree) return <div style={{ padding: 12, color: 'var(--text-faint)' }}>Loading…</div>;
  if (!tree.children?.length)
    return <div style={{ padding: 12, color: 'var(--text-faint)' }}>Vault is empty.</div>;
  return (
    <div onDragOver={(e) => e.preventDefault()} onDrop={onRootDrop} style={{ minHeight: '100%' }}>
      {tree.children.map((c) => (
        <Node key={c.path} node={c} depth={0} />
      ))}
    </div>
  );
}
