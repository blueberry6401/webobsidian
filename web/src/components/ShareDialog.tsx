import { useEffect } from 'react';
import { useStore } from '../lib/store';
import { api } from '../lib/api';
import Icon from './Icon';

/**
 * Per-note share settings popup (FR-10) — opened from the file-tree context
 * menu ("Share…"). Create/copy the public URL, toggle it on/off, manage the
 * password, or delete the link. The centralized list lives in Settings → Sharing.
 */
export default function ShareDialog() {
  const path = useStore((s) => s.shareDialogPath);
  const setShareDialog = useStore((s) => s.setShareDialog);
  const shares = useStore((s) => s.shares);
  const loadShares = useStore((s) => s.loadShares);
  const notify = useStore((s) => s.notify);

  useEffect(() => {
    if (path) loadShares();
  }, [path, loadShares]);

  if (!path) return null;
  const kind: 'file' | 'folder' = /\.(md|markdown|canvas)$/i.test(path) ? 'file' : 'folder';
  const close = () => setShareDialog(null);
  const share = shares.find((s) => s.path === path) ?? null;
  const url = share ? `${location.origin}/share/${share.id}` : '';

  const create = async () => {
    await api.createShare(path, kind);
    await loadShares();
    notify('Public link created');
  };
  const toggle = async () => {
    if (!share) return;
    await api.setShareEnabled(share.id, !share.enabled);
    await loadShares();
  };
  const copy = () => {
    navigator.clipboard?.writeText(url).catch(() => {});
    notify('Public link copied');
  };
  const EXPIRY_PRESETS: { label: string; days: number | null }[] = [
    { label: '1 day', days: 1 },
    { label: '7 days', days: 7 },
    { label: '30 days', days: 30 },
    { label: 'No limit', days: null },
  ];
  const setExpiry = async (days: number | null) => {
    if (!share) return;
    const iso = days === null ? null : new Date(Date.now() + days * 86_400_000).toISOString();
    await api.setShareExpiry(share.id, iso);
    await loadShares();
    notify(days === null ? 'Link no longer expires' : `Link now expires in ${days} day${days === 1 ? '' : 's'}`);
  };
  const password = async () => {
    if (!share) return;
    const pw = prompt(
      share.hasPassword
        ? 'New password for this link (leave empty to REMOVE the password):'
        : 'Password for this link:',
    );
    if (pw === null) return;
    await api.setSharePassword(share.id, pw || null);
    await loadShares();
    notify(pw ? 'Password set' : 'Password removed');
  };
  const remove = async () => {
    if (!share) return;
    if (!confirm('Delete this public link? The URL stops working permanently.')) return;
    await api.deleteShare(share.id);
    await loadShares();
    notify('Public link deleted');
  };

  return (
    <div className="modal-bg" onClick={close}>
      <div className="modal share-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="share-dialog-head">
          <Icon name="globe" size={18} />
          <div>
            <div className="share-dialog-title">
              {kind === 'folder' ? 'Share folder' : /\.canvas$/i.test(path) ? 'Share canvas' : 'Share note'}
            </div>
            <div className="share-dialog-path">{path}</div>
          </div>
        </div>

        {!share && (
          <>
            <p className="share-dialog-hint">
              Create a public link so <b>anyone with the URL</b> can read this note without login.
            </p>
            <button className="btn" onClick={create}>
              <Icon name="globe" size={14} /> Create public link
            </button>
          </>
        )}

        {share && (
          <>
            <div className="setting-row">
              <div className="info">
                <div className="name">Public link</div>
                <div className="desc">{share.enabled ? 'Anyone with the URL can view this note' : 'Sharing is paused — the URL returns 404'}</div>
              </div>
              <button className={`graph-switch ${share.enabled ? 'on' : ''}`} onClick={toggle} aria-label="Toggle public link">
                <span className="graph-knob" />
              </button>
            </div>

            {share.enabled && (
              <div className="share-url">
                <input className="text-input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
                <button className="btn" onClick={copy}><Icon name="link" size={14} /> Copy</button>
              </div>
            )}

            {share.enabled && (
              <div className="setting-row">
                <div className="info">
                  <div className="name">Expiry</div>
                  <div className="desc">
                    {share.expiresAt ? `Expires ${new Date(share.expiresAt).toLocaleDateString()}` : 'Never expires'}
                  </div>
                </div>
              </div>
            )}
            {share.enabled && (
              <div className="recent-filter-row">
                {EXPIRY_PRESETS.map((p) => (
                  <button key={p.label} className="recent-filter-btn" onClick={() => setExpiry(p.days)}>
                    {p.label}
                  </button>
                ))}
              </div>
            )}

            <div className="setting-row">
              <div className="info">
                <div className="name">Password protection</div>
                <div className="desc">{share.hasPassword ? 'Visitors must enter a password' : 'Anyone with the link can open it'}</div>
              </div>
              <button className="btn secondary" onClick={password}>
                {share.hasPassword ? 'Change…' : 'Set password…'}
              </button>
            </div>

            <div className="setting-row">
              <div className="info">
                <div className="name">Delete link</div>
                <div className="desc">Revokes the URL permanently</div>
              </div>
              <button className="btn danger" onClick={remove}>Delete</button>
            </div>
          </>
        )}

        <div className="share-dialog-foot">
          <button className="btn secondary" onClick={close}>Done</button>
        </div>
      </div>
    </div>
  );
}
