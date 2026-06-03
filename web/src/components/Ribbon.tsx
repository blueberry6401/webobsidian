import { useStore } from '../lib/store';
import Icon from './Icon';

export default function Ribbon({ onTheme }: { onTheme: () => void }) {
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const leftPanel = useStore((s) => s.leftPanel);
  const setGraph = useStore((s) => s.setGraph);
  const setSettings = useStore((s) => s.setSettings);
  const setPalette = useStore((s) => s.setPalette);
  const openDailyNote = useStore((s) => s.openDailyNote);

  return (
    <div className="ribbon">
      <button className={leftPanel === 'files' ? 'active' : ''} title="Files" onClick={() => setLeftPanel('files')}>
        <Icon name="file-text" size={18} />
      </button>
      <button className={leftPanel === 'search' ? 'active' : ''} title="Search (⌘⇧F)" onClick={() => setLeftPanel('search')}>
        <Icon name="search" size={18} />
      </button>
      <button title="Graph view" onClick={() => setGraph(true)}>
        <Icon name="graph" size={18} />
      </button>
      <button className={leftPanel === 'bookmarks' ? 'active' : ''} title="Bookmarks & recent" onClick={() => setLeftPanel('bookmarks')}>
        <Icon name="bookmark" size={18} />
      </button>
      <button title="Daily note" onClick={() => openDailyNote()}>
        <Icon name="calendar" size={18} />
      </button>
      <button className={leftPanel === 'tags' ? 'active' : ''} title="Tags" onClick={() => setLeftPanel('tags')}>
        <Icon name="hash" size={18} />
      </button>
      <button title="Command palette (⌘P)" onClick={() => setPalette(true, 'commands')}>
        <Icon name="command" size={18} />
      </button>
      <div className="spacer" />
      <button title="Toggle theme" onClick={onTheme}>
        <Icon name="moon" size={18} />
      </button>
      <button title="Settings" onClick={() => setSettings(true)}>
        <Icon name="settings" size={18} />
      </button>
    </div>
  );
}
