import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import { outline } from '../lib/markdown';
import Icon from './Icon';

export default function RightSidebar() {
  const activePath = useStore((s) => s.activePath);
  const content = useStore((s) => s.content);
  const openFile = useStore((s) => s.openFile);
  const [backlinks, setBacklinks] = useState<string[]>([]);

  useEffect(() => {
    if (!activePath) {
      setBacklinks([]);
      return;
    }
    api.backlinks(activePath).then((r) => setBacklinks(r.backlinks)).catch(() => setBacklinks([]));
  }, [activePath, content]);

  const heads = outline(content);
  const name = (p: string) => p.split('/').pop()?.replace(/\.(md|markdown)$/, '') ?? p;

  return (
    <div className="right-sidebar">
      <div className="nav-header">
        <span className="nav-title">Linked mentions</span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>{backlinks.length}</span>
      </div>
      <div className="sidebar-body" style={{ flex: '1 1 auto' }}>
        {backlinks.length === 0 && <div className="panel-item">No backlinks to this note</div>}
        {backlinks.map((b) => (
          <div key={b} className="mention-box">
            <div className="mention-src" onClick={() => openFile(b)}>
              {name(b)}
            </div>
            <div style={{ color: 'var(--text-faint)' }}>links to {name(activePath ?? '')}</div>
          </div>
        ))}
      </div>
      <div className="nav-header" style={{ borderTop: '1px solid var(--bg-modifier-border)' }}>
        <span className="nav-title">Outline</span>
      </div>
      <div className="sidebar-body" style={{ flex: '0 0 auto', maxHeight: '38%' }}>
        {heads.length === 0 && <div className="panel-item">No headings</div>}
        {heads.map((h, i) => (
          <div key={i} className="outline-item" style={{ paddingLeft: 10 + (h.level - 1) * 12 }}>
            {h.text}
          </div>
        ))}
      </div>
    </div>
  );
}
