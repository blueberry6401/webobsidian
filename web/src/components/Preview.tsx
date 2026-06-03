import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { renderMarkdown } from '../lib/markdown';
import { api } from '../lib/api';

export default function Preview({ source }: { source?: string }) {
  const storeContent = useStore((s) => s.content);
  const content = source ?? storeContent;
  const openWikilink = useStore((s) => s.openWikilink);
  const openContextMenu = useStore((s) => s.openContextMenu);
  const setLeftPanel = useStore((s) => s.setLeftPanel);
  const [html, setHtml] = useState('');

  useEffect(() => {
    let cancelled = false;
    renderMarkdown(content, {
      rawUrl: (p) => api.rawUrl(p),
      resolveEmbed: async (target) => {
        try {
          const { path } = await api.resolve(target);
          if (!path) return null;
          const r = await api.read(path);
          return { path, content: typeof r === 'string' ? r : r.content };
        } catch {
          return null;
        }
      },
    }).then((h) => {
      if (!cancelled) setHtml(h);
    });
    return () => {
      cancelled = true;
    };
  }, [content]);

  const onClick = (e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-wikilink]') as HTMLElement | null;
    if (target) {
      e.preventDefault();
      const link = target.getAttribute('data-wikilink');
      if (link) openWikilink(link);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const sel = window.getSelection()?.toString() ?? '';
    e.preventDefault();
    openContextMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: 'Copy', icon: 'file-text', onClick: () => sel && navigator.clipboard.writeText(sel).catch(() => {}) },
        ...(sel
          ? [{ label: `Search for “${sel.slice(0, 24)}”`, icon: 'search', onClick: () => setLeftPanel('search') }]
          : []),
        { label: '', separator: true },
        { label: 'Select all', onClick: () => {
            const r = document.createRange();
            const el = (e.currentTarget as HTMLElement);
            r.selectNodeContents(el);
            const s = window.getSelection();
            s?.removeAllRanges();
            s?.addRange(r);
          } },
      ],
    });
  };

  return (
    <div className="markdown-preview" onClick={onClick} onContextMenu={onContextMenu}>
      <div className="preview-inner" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
