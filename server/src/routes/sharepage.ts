// SSR page for public share links (FR-10): GET /share/:id returns a complete
// HTML document — note content, <title>, meta description, Open Graph + Twitter
// tags — so crawlers (Google, FB, Zalo…) index/preview it without running JS.
// Folder shares (kind: 'folder') are SSR too: GET /share/:id (root) and
// GET /share/:id/f?path=<subpath> render a read-only file browser, one page
// per level/file — no client-side JS is required to browse or read any of it.
import { Router } from 'express';
import type { Request } from 'express';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { asyncHandler } from '../middleware/error.js';
import * as vault from '../services/vault.js';
import type { TreeNode } from '../services/vault.js';
import { getShareStatus, type ShareRecord } from '../services/shares.js';
import { isUnlocked, isMd, isCanvas, resolveInShareFolder } from './shares.js';
import { renderNoteHtml, metaDescription, firstImage, escapeHtml } from '../services/renderhtml.js';
import { renderCanvasHtml, canvasDescription, canvasFirstImage, canvasViewerScript } from '../services/rendercanvas.js';
import { IMAGE_EXT_RE, VIDEO_EXT_RE, AUDIO_EXT_RE } from '../services/mime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Inline the built SPA stylesheet so the SSR page matches the Reading view. */
let cssCache: { file: string; css: string } | null = null;
async function appCss(): Promise<string> {
  const assets = path.join(__dirname, '..', '..', 'public', 'assets');
  try {
    const files = (await fs.readdir(assets)).filter((f) => /^index-.*\.css$/.test(f)).sort();
    const file = files.at(-1);
    if (!file) return '';
    if (cssCache?.file !== file) {
      cssCache = { file, css: await fs.readFile(path.join(assets, file), 'utf8') };
    }
    return cssCache.css;
  } catch {
    return '';
  }
}

function baseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host')}`;
}

function page(opts: {
  title: string;
  head?: string;
  body: string;
  css: string;
  noindex?: boolean;
  /** Skip the narrow markdown-preview column (used by the full-width canvas view). */
  bare?: boolean;
}): string {
  const inner = opts.bare
    ? opts.body
    : `<div class="markdown-preview">
<div class="preview-inner">
${opts.body}
</div>
</div>`;
  return `<!doctype html>
<html lang="vi">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="${opts.noindex ? 'noindex, nofollow' : 'index, follow'}" />
<title>${escapeHtml(opts.title)}</title>
${opts.head ?? ''}<style>${opts.css}</style>
</head>
<body>
<div class="theme-light public-page${opts.bare ? ' public-canvas' : ''}">
${inner}
</div>
</body>
</html>`;
}

const notFoundPage = (css: string) =>
  page({
    title: 'Note not found',
    noindex: true,
    css,
    body: '<div class="public-error">This note is not available.</div>',
  });

const expiredPage = (css: string) =>
  page({
    title: 'Link expired',
    noindex: true,
    css,
    body: '<div class="public-error">This share link has expired.</div>',
  });

function unlockPage(share: ShareRecord, css: string, nonce: string): string {
  return page({
    title: 'Protected note',
    noindex: true,
    css,
    body: `
<form class="public-unlock" id="unlock-form">
  <div class="public-unlock-title">This note is password-protected</div>
  <input class="text-input" type="password" id="unlock-pw" placeholder="Password" autofocus />
  <button class="btn" type="submit">Open note</button>
  <div class="public-unlock-error" id="unlock-err"></div>
</form>
<script nonce="${nonce}">
document.getElementById('unlock-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const r = await fetch('/public/shares/${share.id}/unlock', {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: document.getElementById('unlock-pw').value }),
  }).catch(() => null);
  if (r && r.ok) location.reload();
  else document.getElementById('unlock-err').textContent = 'Wrong password — try again.';
});
</script>`,
  });
}

/** Breadcrumb for a path inside a folder share: root name, then each segment. */
function breadcrumb(share: ShareRecord, rel: string): string {
  const rootName = share.path.split('/').pop() ?? share.path;
  const relToRoot = rel === share.path ? '' : rel.slice(share.path.length + 1);
  const segs = relToRoot ? relToRoot.split('/') : [];
  const rootPart = segs.length === 0
    ? `<span>${escapeHtml(rootName)}</span>`
    : `<a href="/share/${share.id}">${escapeHtml(rootName)}</a>`;
  const parts = [rootPart];
  let acc = '';
  segs.forEach((seg, i) => {
    acc = acc ? `${acc}/${seg}` : seg;
    const isLast = i === segs.length - 1;
    parts.push(
      isLast
        ? `<span>${escapeHtml(seg)}</span>`
        : `<a href="/share/${share.id}/f?path=${encodeURIComponent(acc)}">${escapeHtml(seg)}</a>`,
    );
  });
  return `<div class="public-breadcrumb">${parts.join(' <span class="public-breadcrumb-sep">/</span> ')}</div>`;
}

/** Read-only listing of a folder-share directory (reuses the in-app FolderView look). */
async function folderListingBody(share: ShareRecord, rel: string): Promise<string> {
  const entries: TreeNode[] = await vault.listDir(rel);
  const crumb = breadcrumb(share, rel);
  if (entries.length === 0) return `${crumb}<p class="folder-empty">This folder is empty.</p>`;
  const rows = entries
    .map((e) => {
      const childSub = e.path.slice(share.path.length + 1);
      const href = `/share/${share.id}/f?path=${encodeURIComponent(childSub)}`;
      const label = e.type === 'file' ? e.name.replace(/\.(md|markdown)$/i, '') : `${e.name}/`;
      const thumb = e.type === 'file' && IMAGE_EXT_RE.test(e.name)
        ? `<img class="folder-thumb" src="/public/shares/${share.id}/file?path=${encodeURIComponent(childSub)}" alt="" loading="lazy" />`
        : '';
      return `<a class="folder-entry" href="${href}">${thumb}<span class="folder-entry-name">${escapeHtml(label)}</span></a>`;
    })
    .join('');
  return `${crumb}<div class="folder-list">${rows}</div>`;
}

function mediaViewerBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(rel)}`;
  const tag = IMAGE_EXT_RE.test(name)
    ? `<img class="public-file-media" src="${url}" alt="${escapeHtml(name)}" />`
    : VIDEO_EXT_RE.test(name)
      ? `<video class="public-file-media" src="${url}" controls preload="metadata"></video>`
      : `<audio src="${url}" controls preload="metadata"></audio>`;
  return `${breadcrumb(share, rel)}<div class="public-file-view">${tag}</div>`;
}

function downloadBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(rel)}`;
  return `${breadcrumb(share, rel)}<div class="public-file-download"><p>${escapeHtml(name)}</p><a class="btn" href="${url}" download>Download</a></div>`;
}

export const sharePageRouter = Router();

sharePageRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    const css = await appCss();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (status.status === 'not_found') {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (status.status === 'expired') {
      res.status(404).send(expiredPage(css));
      return;
    }
    const share = status.record;
    if (!(await vault.exists(share.path))) {
      res.status(404).send(notFoundPage(css));
      return;
    }

    // Password-protected & not unlocked: render the unlock form only — never
    // leak content or descriptive metadata to crawlers.
    if (!(await isUnlocked(req, share))) {
      res.send(unlockPage(share, css, res.locals.cspNonce));
      return;
    }

    if (share.kind === 'folder') {
      const title = share.path.split('/').pop() ?? share.path;
      const body = await folderListingBody(share, share.path);
      res.send(
        page({
          title,
          noindex: true,
          css,
          body: `<div class="inline-title">${escapeHtml(title)}</div>\n${body}`,
        }),
      );
      return;
    }

    const pageUrl = `${baseUrl(req)}/share/${share.id}`;
    const content = await vault.readFileText(share.path);
    const isCv = isCanvas(share.path);
    const title = (share.path.split('/').pop() ?? share.path).replace(/\.(md|markdown|canvas)$/i, '');
    const fileUrl = (p: string) => `/public/shares/${share.id}/file?path=${encodeURIComponent(p)}`;
    const desc = isCv ? canvasDescription(content) : metaDescription(content);
    const imgVault = isCv ? canvasFirstImage(content) : null;
    const img = isCv ? null : firstImage(content);
    const ogImage = img?.url ?? (img?.vault ?? imgVault
      ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent((img?.vault ?? imgVault) as string)}`
      : null);

    const html = isCv
      ? await renderCanvasHtml(content, fileUrl)
      : await renderNoteHtml(content, fileUrl);

    const head = [
      `<meta name="description" content="${escapeHtml(desc)}" />`,
      `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
      `<meta property="og:type" content="article" />`,
      `<meta property="og:site_name" content="WebObsidian" />`,
      `<meta property="og:title" content="${escapeHtml(title)}" />`,
      `<meta property="og:description" content="${escapeHtml(desc)}" />`,
      `<meta property="og:url" content="${escapeHtml(pageUrl)}" />`,
      ...(ogImage ? [
        `<meta property="og:image" content="${escapeHtml(ogImage)}" />`,
        `<meta name="twitter:card" content="summary_large_image" />`,
        `<meta name="twitter:image" content="${escapeHtml(ogImage)}" />`,
      ] : [
        `<meta name="twitter:card" content="summary" />`,
      ]),
      `<meta name="twitter:title" content="${escapeHtml(title)}" />`,
      `<meta name="twitter:description" content="${escapeHtml(desc)}" />`,
    ].join('\n') + '\n';

    res.send(
      page({
        title,
        head,
        css,
        bare: isCv,
        body: isCv
          ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
          : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}`,
      }),
    );
  }),
);

sharePageRouter.get(
  '/:id/f',
  asyncHandler(async (req, res) => {
    const status = await getShareStatus(req.params.id);
    const css = await appCss();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');

    if (status.status === 'not_found') {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (status.status === 'expired') {
      res.status(404).send(expiredPage(css));
      return;
    }
    const share = status.record;
    if (share.kind !== 'folder' || !(await vault.exists(share.path))) {
      res.status(404).send(notFoundPage(css));
      return;
    }
    if (!(await isUnlocked(req, share))) {
      res.send(unlockPage(share, css, res.locals.cspNonce));
      return;
    }

    const rel = await resolveInShareFolder(share, String(req.query.path ?? ''));
    if (!rel) {
      res.status(404).send(notFoundPage(css));
      return;
    }

    if (await vault.isDirectory(rel)) {
      const title = rel.split('/').pop() ?? rel;
      const body = await folderListingBody(share, rel);
      res.send(
        page({ title, noindex: true, css, body: `<div class="inline-title">${escapeHtml(title)}</div>\n${body}` }),
      );
      return;
    }

    if (!(await vault.exists(rel))) {
      res.status(404).send(notFoundPage(css));
      return;
    }

    const name = rel.split('/').pop() ?? rel;

    if (isMd(rel) || isCanvas(rel)) {
      const content = await vault.readFileText(rel);
      const isCv = isCanvas(rel);
      const fileUrl = (p: string) => `/public/shares/${share.id}/file?path=${encodeURIComponent(p)}`;
      const html = isCv ? await renderCanvasHtml(content, fileUrl) : await renderNoteHtml(content, fileUrl);
      const title = name.replace(/\.(md|markdown|canvas)$/i, '');
      res.send(
        page({
          title,
          noindex: true,
          css,
          bare: isCv,
          body: `${breadcrumb(share, rel)}\n${
            isCv
              ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
              : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}`
          }`,
        }),
      );
      return;
    }

    if (IMAGE_EXT_RE.test(name) || VIDEO_EXT_RE.test(name) || AUDIO_EXT_RE.test(name)) {
      res.send(page({ title: name, noindex: true, css, body: mediaViewerBody(share, rel, name) }));
      return;
    }

    res.send(page({ title: name, noindex: true, css, body: downloadBody(share, rel, name) }));
  }),
);
