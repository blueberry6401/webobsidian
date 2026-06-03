import { useStore } from '../lib/store';
import Icon from './Icon';

export default function BookmarksPanel() {
  const bookmarks = useStore((s) => s.bookmarks);
  const recent = useStore((s) => s.recent);
  const openFile = useStore((s) => s.openFile);
  const toggleBookmark = useStore((s) => s.toggleBookmark);

  const name = (p: string) => p.split('/').pop()?.replace(/\.(md|markdown)$/, '') ?? p;

  return (
    <div>
      <div className="panel-title">Bookmarks</div>
      {bookmarks.length === 0 && <div className="panel-item">No bookmarks yet</div>}
      {bookmarks.map((b) => (
        <div key={b} className="panel-item" onClick={() => openFile(b)} title={b}>
          <Icon name="bookmark" size={14} /> <span style={{ flex: 1 }}>{name(b)}</span>
          <span
            style={{ opacity: 0.5, display: 'flex' }}
            onClick={(e) => {
              e.stopPropagation();
              toggleBookmark(b);
            }}
          >
            <Icon name="x" size={13} />
          </span>
        </div>
      ))}
      <div className="panel-title" style={{ marginTop: 8 }}>Recent</div>
      {recent.length === 0 && <div className="panel-item">No recent files</div>}
      {recent.map((r) => (
        <div key={r} className="panel-item" onClick={() => openFile(r)} title={r}>
          <Icon name="clock" size={14} /> {name(r)}
        </div>
      ))}
    </div>
  );
}
