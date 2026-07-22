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
import { renderNoteHtml, metaDescription, firstImage, escapeHtml, headingFoldScript } from '../services/renderhtml.js';
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

/**
 * Open Graph + Twitter card meta tags, shared by every public page — including
 * folder listings, which are `noindex` (kept out of search results) but still
 * need OG tags so link previews render in messaging apps (WhatsApp, Zalo,
 * Telegram…): "don't index this" and "show a preview when shared" are
 * unrelated concerns.
 */
function ogHead(opts: {
  pageUrl: string;
  title: string;
  desc: string;
  ogType?: 'article' | 'website';
  ogImage?: string | null;
}): string {
  const { pageUrl, title, desc, ogType = 'website', ogImage = null } = opts;
  return [
    `<meta name="description" content="${escapeHtml(desc)}" />`,
    `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
    `<meta property="og:type" content="${ogType}" />`,
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
}

function page(opts: {
  title: string;
  head?: string;
  body: string;
  css: string;
  noindex?: boolean;
  /** Skip the narrow markdown-preview column (used by the full-width canvas view). */
  bare?: boolean;
  /**
   * Folder-tree nav rendered as a persistent left column (pure HTML —
   * <details>/<summary> gives expand/collapse with no client JS), so
   * visitors can jump between files inside a shared folder without
   * bouncing back to the listing page each time.
   */
  sidebar?: string;
}): string {
  const inner = opts.bare
    ? opts.body
    : `<div class="markdown-preview">
<div class="preview-inner">
${opts.body}
</div>
</div>`;
  const withSidebar = opts.sidebar
    ? `<div class="public-folder-layout">
<nav class="public-folder-nav">${opts.sidebar}</nav>
<div class="public-folder-main">${inner}</div>
</div>`
    : inner;
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
<div class="theme-light public-page${opts.bare ? ' public-canvas' : ''}${opts.sidebar ? ' has-folder-nav' : ''}">
${withSidebar}
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

// Same Lucide path data as web/src/components/Icon.tsx, inlined here since the
// SSR folder listing has no React runtime to render <Icon> from.
const ICON_PATHS = {
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  'file-text': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
  image: '<rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21"/>',
  'file-pdf': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M9 13v5"/><path d="M9 13h2a1.5 1.5 0 0 1 0 3H9"/>',
  paperclip: '<path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 0 0-5.657-5.657l-8.379 8.551a6 6 0 0 0 8.485 8.485l8.379-8.551"/>',
} as const;

function svgIcon(name: keyof typeof ICON_PATHS): string {
  return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name]}</svg>`;
}

/** Mirrors web/src/components/FolderView.tsx's entryIcon() for the same folder→icon mapping. */
function entryIcon(e: TreeNode): keyof typeof ICON_PATHS {
  if (e.type === 'folder') return 'folder';
  const ext = e.ext ?? '';
  if (/\.(md|markdown)$/i.test(ext)) return 'file-text';
  if (IMAGE_EXT_RE.test(ext)) return 'image';
  if (ext === '.pdf') return 'file-pdf';
  return 'paperclip';
}

/** Recursively walk a folder share's subtree (bounded to the shared folder, not the whole vault). */
async function buildFolderTree(rel: string, name: string): Promise<TreeNode> {
  const entries = await vault.listDir(rel);
  const children = await Promise.all(
    entries.map((e) => (e.type === 'folder' ? buildFolderTree(e.path, e.name) : Promise.resolve(e))),
  );
  return { name, path: rel, type: 'folder', children };
}

/**
 * Persistent left-column nav for every page inside a folder share — plain
 * <details>/<summary> for expand/collapse (no client JS). Folders on the
 * path to `currentRel` start expanded so the current location is visible;
 * everything else starts collapsed to keep large shares manageable.
 */
function renderTreeNav(share: ShareRecord, node: TreeNode, currentRel: string): string {
  if (node.type === 'file') {
    const isCurrent = node.path === currentRel;
    const href = `/share/${share.id}/f?path=${encodeURIComponent(toShareRel(share, node.path))}`;
    const label = node.name.replace(/\.(md|markdown)$/i, '');
    return `<li><a class="folder-nav-item${isCurrent ? ' is-current' : ''}" href="${href}">${svgIcon(entryIcon(node))}<span>${escapeHtml(label)}</span></a></li>`;
  }
  const isRoot = node.path === share.path;
  const isAncestorOfCurrent = currentRel === node.path || currentRel.startsWith(`${node.path}/`);
  const href = isRoot ? `/share/${share.id}` : `/share/${share.id}/f?path=${encodeURIComponent(toShareRel(share, node.path))}`;
  const items = (node.children ?? []).map((c) => renderTreeNav(share, c, currentRel)).join('');
  return `<li><details${isAncestorOfCurrent ? ' open' : ''}><summary><a class="folder-nav-item${node.path === currentRel ? ' is-current' : ''}" href="${href}">${svgIcon('folder')}<span>${escapeHtml(node.name)}</span></a></summary><ul>${items}</ul></details></li>`;
}

async function folderSidebar(share: ShareRecord, currentRel: string): Promise<string> {
  const rootName = share.path.split('/').pop() ?? share.path;
  const tree = await buildFolderTree(share.path, rootName);
  return `<ul class="folder-nav-tree">${renderTreeNav(share, tree, currentRel)}</ul>`;
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

/**
 * Convert a full vault-relative path (as returned by resolveInShareFolder /
 * vault.listDir) to a share-root-relative subpath, e.g. `E2E-Share/Sub/x.png`
 * -> `Sub/x.png` for a share rooted at `E2E-Share`. This is what
 * GET /public/shares/:id/file and GET /share/:id/f both expect as `?path=`
 * (share-relative), NOT the full vault path.
 */
function toShareRel(share: ShareRecord, rel: string): string {
  return rel === share.path ? '' : rel.slice(share.path.length + 1);
}

/** OG description + image for a folder listing: item counts, first direct-child image. */
async function folderMeta(
  share: ShareRecord,
  rel: string,
  req: Request,
): Promise<{ desc: string; ogImage: string | null }> {
  const entries = await vault.listDir(rel);
  const folders = entries.filter((e) => e.type === 'folder').length;
  const files = entries.filter((e) => e.type === 'file').length;
  const desc = `${folders} folder${folders === 1 ? '' : 's'} · ${files} file${files === 1 ? '' : 's'}`;
  const firstImg = entries.find((e) => e.type === 'file' && IMAGE_EXT_RE.test(e.name));
  const ogImage = firstImg
    ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent(toShareRel(share, firstImg.path))}`
    : null;
  return { desc, ogImage };
}

/** Read-only listing of a folder-share directory (reuses the in-app FolderView look). */
async function folderListingBody(share: ShareRecord, rel: string): Promise<string> {
  const entries: TreeNode[] = await vault.listDir(rel);
  const crumb = breadcrumb(share, rel);
  if (entries.length === 0) return `${crumb}<p class="folder-empty">This folder is empty.</p>`;
  const rows = entries
    .map((e) => {
      const childSub = toShareRel(share, e.path);
      const href = `/share/${share.id}/f?path=${encodeURIComponent(childSub)}`;
      const label = e.type === 'file' ? e.name.replace(/\.(md|markdown)$/i, '') : `${e.name}/`;
      const icon = e.type === 'file' && IMAGE_EXT_RE.test(e.name)
        ? `<img class="folder-thumb" src="/public/shares/${share.id}/file?path=${encodeURIComponent(childSub)}" alt="" loading="lazy" />`
        : svgIcon(entryIcon(e));
      return `<a class="folder-entry" href="${href}">${icon}<span class="folder-entry-name">${escapeHtml(label)}</span></a>`;
    })
    .join('');
  return `${crumb}<div class="folder-list">${rows}</div>`;
}

function mediaViewerBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(toShareRel(share, rel))}`;
  const tag = IMAGE_EXT_RE.test(name)
    ? `<img class="public-file-media" src="${url}" alt="${escapeHtml(name)}" />`
    : VIDEO_EXT_RE.test(name)
      ? `<video class="public-file-media" src="${url}" controls preload="metadata"></video>`
      : `<audio src="${url}" controls preload="metadata"></audio>`;
  return `${breadcrumb(share, rel)}<div class="public-file-view">${tag}</div>`;
}

function downloadBody(share: ShareRecord, rel: string, name: string): string {
  const url = `/public/shares/${share.id}/file?path=${encodeURIComponent(toShareRel(share, rel))}`;
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
      const pageUrl = `${baseUrl(req)}/share/${share.id}`;
      const { desc, ogImage } = await folderMeta(share, share.path, req);
      const body = await folderListingBody(share, share.path);
      const sidebar = await folderSidebar(share, share.path);
      res.send(
        page({
          title,
          noindex: true,
          css,
          head: ogHead({ pageUrl, title, desc, ogImage }),
          sidebar,
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

    res.send(
      page({
        title,
        head: ogHead({ pageUrl, title, desc, ogType: 'article', ogImage }),
        css,
        bare: isCv,
        body: isCv
          ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
          : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}\n${headingFoldScript(res.locals.cspNonce)}`,
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

    const subUrl = `${baseUrl(req)}/share/${share.id}/f?path=${encodeURIComponent(toShareRel(share, rel))}`;

    if (await vault.isDirectory(rel)) {
      const title = rel.split('/').pop() ?? rel;
      const { desc, ogImage } = await folderMeta(share, rel, req);
      const body = await folderListingBody(share, rel);
      const sidebar = await folderSidebar(share, rel);
      res.send(
        page({
          title,
          noindex: true,
          css,
          head: ogHead({ pageUrl: subUrl, title, desc, ogImage }),
          sidebar,
          body: `<div class="inline-title">${escapeHtml(title)}</div>\n${body}`,
        }),
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
      const desc = isCv ? canvasDescription(content) : metaDescription(content);
      const imgVault = isCv ? canvasFirstImage(content) : null;
      const img = isCv ? null : firstImage(content);
      const ogImage = img?.url ?? (img?.vault ?? imgVault
        ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent((img?.vault ?? imgVault) as string)}`
        : null);
      // Canvas keeps the existing full-width, sidebar-free layout — it needs
      // the horizontal space, unlike a note column.
      const sidebar = isCv ? undefined : await folderSidebar(share, rel);
      res.send(
        page({
          title,
          noindex: true,
          css,
          bare: isCv,
          head: ogHead({ pageUrl: subUrl, title, desc, ogType: 'article', ogImage }),
          sidebar,
          body: `${breadcrumb(share, rel)}\n${
            isCv
              ? `<div class="public-canvas-title">${escapeHtml(title)}</div>\n${html}\n${canvasViewerScript(res.locals.cspNonce)}`
              : `<div class="inline-title">${escapeHtml(title)}</div>\n${html}\n${headingFoldScript(res.locals.cspNonce)}`
          }`,
        }),
      );
      return;
    }

    if (IMAGE_EXT_RE.test(name) || VIDEO_EXT_RE.test(name) || AUDIO_EXT_RE.test(name)) {
      const ogImage = IMAGE_EXT_RE.test(name)
        ? `${baseUrl(req)}/public/shares/${share.id}/file?path=${encodeURIComponent(toShareRel(share, rel))}`
        : null;
      res.send(
        page({
          title: name,
          noindex: true,
          css,
          head: ogHead({ pageUrl: subUrl, title: name, desc: `Shared file — ${name}`, ogImage }),
          sidebar: await folderSidebar(share, rel),
          body: mediaViewerBody(share, rel, name),
        }),
      );
      return;
    }

    res.send(
      page({
        title: name,
        noindex: true,
        css,
        head: ogHead({ pageUrl: subUrl, title: name, desc: `Shared file — ${name}` }),
        sidebar: await folderSidebar(share, rel),
        body: downloadBody(share, rel, name),
      }),
    );
  }),
);
