import { useStore } from '../lib/store';
import FileTree from './FileTree';
import SearchPanel from './SearchPanel';
import TagsPanel from './TagsPanel';
import BookmarksPanel from './BookmarksPanel';
import Icon from './Icon';
import { api } from '../lib/api';

const TITLES: Record<string, string> = {
  files: 'Files',
  search: 'Search',
  tags: 'Tags',
  bookmarks: 'Bookmarks',
};

export default function Sidebar() {
  const leftPanel = useStore((s) => s.leftPanel);
  const loadTree = useStore((s) => s.loadTree);
  const createNote = useStore((s) => s.createNote);
  const setSettings = useStore((s) => s.setSettings);
  const vaultName = useStore((s) => s.tree?.name) || 'Vault';

  const newNote = async () => {
    const name = prompt('New note name', 'Untitled.md');
    if (!name) return;
    const path = name.endsWith('.md') ? name : `${name}.md`;
    await createNote(path, `# ${path.replace(/\.md$/, '')}\n`);
  };
  const newFolder = async () => {
    const name = prompt('New folder name', 'Folder');
    if (!name) return;
    await api.createFolder(name);
    await loadTree();
  };

  return (
    <div className="sidebar">
      <div className="nav-header">
        <span className="nav-title">{TITLES[leftPanel]}</span>
        {leftPanel === 'files' && (
          <>
            <button className="nav-action" title="New note" onClick={newNote}>
              <Icon name="file-plus" size={16} />
            </button>
            <button className="nav-action" title="New folder" onClick={newFolder}>
              <Icon name="folder-plus" size={16} />
            </button>
            <button className="nav-action" title="Refresh" onClick={() => loadTree()}>
              <Icon name="refresh-cw" size={16} />
            </button>
          </>
        )}
      </div>
      <div className="sidebar-body">
        {leftPanel === 'files' && <FileTree />}
        {leftPanel === 'search' && <SearchPanel />}
        {leftPanel === 'tags' && <TagsPanel />}
        {leftPanel === 'bookmarks' && <BookmarksPanel />}
      </div>
      <div className="vault-footer">
        <span className="vault-name">
          <Icon name="gem" size={15} /> {vaultName}
        </span>
        <span className="grow" />
        <button title="Settings" onClick={() => setSettings(true)}>
          <Icon name="settings" size={16} />
        </button>
      </div>
    </div>
  );
}
