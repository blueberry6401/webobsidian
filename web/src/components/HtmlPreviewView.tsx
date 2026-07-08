import { useEffect, useRef, useState } from 'react';
import { api, type HtmlPreviewRecord } from '../lib/api';
import { useStore } from '../lib/store';
import Icon from './Icon';

const POLL_MS = 2500;

/**
 * Tab content for an HTML Preview (sentinel path htmlpreview://<id>, see store.ts).
 * Polls while the backend is still generating — this is what makes a mid-generation
 * page reload recover correctly: the tab just re-fetches this same record on mount.
 */
export default function HtmlPreviewView({ previewId }: { previewId: string }) {
  const notify = useStore((s) => s.notify);
  const [preview, setPreview] = useState<HtmlPreviewRecord | null>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState(false);
  const timerRef = useRef<number>();

  const load = async () => {
    try {
      const r = await api.getHtmlPreview(previewId);
      setPreview(r.preview);
      setHtml(r.html);
    } catch {
      setPreview(null);
      setHtml(null);
    }
  };

  useEffect(() => {
    load();
    return () => window.clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewId]);

  useEffect(() => {
    window.clearInterval(timerRef.current);
    if (preview?.status === 'generating') {
      timerRef.current = window.setInterval(load, POLL_MS);
    }
    return () => window.clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preview?.status, previewId]);

  const regenerate = async () => {
    setRegenerating(true);
    try {
      await api.regenerateHtmlPreview(previewId);
      await load();
    } catch (e: any) {
      notify(e.message ?? 'Tạo lại thất bại');
    } finally {
      setRegenerating(false);
    }
  };

  if (!preview) {
    return (
      <div className="markdown-preview">
        <div className="preview-inner">Đang tải…</div>
      </div>
    );
  }

  return (
    <div className="html-preview-view">
      <div className="html-preview-toolbar">
        {preview.status === 'generating' && <span className="html-preview-badge generating">Đang tạo…</span>}
        {preview.status === 'error' && <span className="html-preview-badge error">Lỗi: {preview.error}</span>}
        {preview.status === 'done' && preview.outOfSync && (
          <span className="html-preview-badge outofsync">Lệch với note</span>
        )}
        {preview.status === 'done' && !preview.outOfSync && <span className="html-preview-badge synced">Đã đồng bộ</span>}
        <span className="grow" />
        <button className="btn secondary" onClick={regenerate} disabled={regenerating || preview.status === 'generating'}>
          <Icon name="refresh-cw" size={14} /> {regenerating ? 'Đang tạo lại…' : 'Tạo lại'}
        </button>
      </div>
      <div className="html-preview-frame-wrap">
        {preview.status === 'done' && html ? (
          <iframe className="html-preview-frame" sandbox="allow-scripts" srcDoc={html} title={preview.name} />
        ) : (
          <div className="markdown-preview">
            <div className="preview-inner">
              {preview.status === 'generating' ? 'Đang tạo HTML preview…' : preview.status === 'error' ? preview.error : ''}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
