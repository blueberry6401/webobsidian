import { useEffect, useState } from 'react';
import { useStore } from '../lib/store';
import { api, type HtmlPreviewRecord, type HtmlTemplate } from '../lib/api';
import Icon from './Icon';

const POLL_MS = 2500;

function statusLabel(p: HtmlPreviewRecord): string {
  if (p.status === 'generating') return 'Đang tạo…';
  if (p.status === 'error') return `Lỗi: ${p.error ?? 'không rõ'}`;
  return p.outOfSync ? 'Lệch với note' : 'Đã đồng bộ';
}

/**
 * Per-note HTML Preview management dialog (opened from the pane "⋯" menu).
 * Lists every preview generated for this note (each bound to a prompt/template),
 * lets you open/rename/delete one, or start a new generation.
 */
export default function HtmlPreviewDialog() {
  const notePath = useStore((s) => s.htmlPreviewDialogPath);
  const setDialog = useStore((s) => s.setHtmlPreviewDialog);
  const openHtmlPreview = useStore((s) => s.openHtmlPreview);
  const notify = useStore((s) => s.notify);

  const [previews, setPreviews] = useState<HtmlPreviewRecord[]>([]);
  const [templates, setTemplates] = useState<HtmlTemplate[]>([]);
  const [creating, setCreating] = useState(false);
  const [templateId, setTemplateId] = useState('');
  const [prompt, setPrompt] = useState('');
  const [name, setName] = useState('');
  const [saveAsTemplate, setSaveAsTemplate] = useState(false);
  const [templateName, setTemplateName] = useState('');
  const [busy, setBusy] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');

  const load = async () => {
    if (!notePath) return;
    const [{ previews: p }, settings] = await Promise.all([api.listHtmlPreviews(notePath), api.getSettings()]);
    setPreviews(p);
    setTemplates(settings.llm?.templates ?? []);
  };

  useEffect(() => {
    if (notePath) {
      load();
      setCreating(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath]);

  // Poll while anything is still generating, so the status labels update live.
  useEffect(() => {
    if (!notePath) return;
    if (!previews.some((p) => p.status === 'generating')) return;
    const t = window.setInterval(load, POLL_MS);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [notePath, previews]);

  if (!notePath) return null;
  const close = () => setDialog(null);

  const startCreate = () => {
    setCreating(true);
    setTemplateId('');
    setPrompt('');
    setName('');
    setSaveAsTemplate(false);
    setTemplateName('');
  };

  const submit = async () => {
    if (!templateId && !prompt.trim()) {
      notify('Chọn template hoặc gõ prompt');
      return;
    }
    setBusy(true);
    try {
      const { preview } = await api.createHtmlPreview({
        notePath,
        templateId: templateId || null,
        prompt: templateId ? undefined : prompt.trim(),
        name: name.trim() || undefined,
        saveAsTemplate: saveAsTemplate && templateName.trim() ? { name: templateName.trim() } : undefined,
      });
      setDialog(null);
      await openHtmlPreview(preview.id, preview.name);
    } catch (e: any) {
      notify(e.message ?? 'Tạo preview thất bại');
    } finally {
      setBusy(false);
    }
  };

  const open = async (p: HtmlPreviewRecord) => {
    setDialog(null);
    await openHtmlPreview(p.id, p.name);
  };

  const startRename = (p: HtmlPreviewRecord) => {
    setRenamingId(p.id);
    setRenameDraft(p.name);
  };
  const commitRename = async (id: string) => {
    const trimmed = renameDraft.trim();
    setRenamingId(null);
    if (!trimmed) return;
    await api.renameHtmlPreview(id, trimmed);
    await load();
  };
  const remove = async (p: HtmlPreviewRecord) => {
    if (!confirm(`Xoá preview "${p.name}"?`)) return;
    await api.deleteHtmlPreview(p.id);
    await load();
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal share-dialog html-preview-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-dialog-head">
          <Icon name="file-code" size={18} />
          <div>
            <div className="share-dialog-title">HTML Preview</div>
            <div className="share-dialog-path">{notePath}</div>
          </div>
        </div>

        {previews.length === 0 && !creating && (
          <p className="share-dialog-hint">Chưa có bản preview nào cho note này.</p>
        )}

        {!creating &&
          previews.map((p) => (
            <div className="setting-row" key={p.id}>
              <div className="info" style={{ minWidth: 0, cursor: 'pointer' }} onClick={() => open(p)}>
                {renamingId === p.id ? (
                  <input
                    className="text-input"
                    autoFocus
                    value={renameDraft}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    onBlur={() => commitRename(p.id)}
                    onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
                  />
                ) : (
                  <div className="name" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {p.name}
                  </div>
                )}
                <div className="desc">{statusLabel(p)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                <button className="btn secondary" onClick={(e) => { e.stopPropagation(); startRename(p); }}>
                  <Icon name="pencil" size={14} />
                </button>
                <button className="btn danger" onClick={(e) => { e.stopPropagation(); remove(p); }}>
                  <Icon name="trash" size={14} />
                </button>
              </div>
            </div>
          ))}

        {!creating && (
          <button className="btn" onClick={startCreate} style={{ marginTop: 10 }}>
            <Icon name="plus" size={14} /> Tạo preview mới
          </button>
        )}

        {creating && (
          <div style={{ marginTop: 10 }}>
            <div className="setting-row">
              <div className="info">
                <div className="name">Template có sẵn</div>
              </div>
              <select className="text-input" value={templateId} onChange={(e) => setTemplateId(e.target.value)}>
                <option value="">— Gõ prompt tuỳ ý —</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </div>
            {!templateId && (
              <>
                <textarea
                  className="text-input"
                  style={{ width: '100%', height: 90, boxSizing: 'border-box', marginTop: 6 }}
                  placeholder="Mô tả cách bạn muốn HTML preview trông như thế nào…"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                />
                <label style={{ display: 'block', marginTop: 6 }}>
                  <input type="checkbox" checked={saveAsTemplate} onChange={(e) => setSaveAsTemplate(e.target.checked)} /> Lưu
                  thành template
                </label>
                {saveAsTemplate && (
                  <input
                    className="text-input"
                    style={{ width: '100%', marginTop: 6 }}
                    placeholder="Tên template"
                    value={templateName}
                    onChange={(e) => setTemplateName(e.target.value)}
                  />
                )}
              </>
            )}
            <input
              className="text-input"
              style={{ width: '100%', marginTop: 6 }}
              placeholder="Tên bản preview (tuỳ chọn)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn" onClick={submit} disabled={busy}>
                {busy ? 'Đang tạo…' : 'Generate'}
              </button>
              <button className="btn secondary" onClick={() => setCreating(false)}>
                Huỷ
              </button>
            </div>
          </div>
        )}

        <div className="share-dialog-foot">
          <button className="btn secondary" onClick={close}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
