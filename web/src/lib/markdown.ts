import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeRaw from 'rehype-raw';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeStringify from 'rehype-stringify';

// Sanitize schema extended to keep the attributes our wikilinks/callouts use.
const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    a: [...(defaultSchema.attributes?.a ?? []), ['className'], ['dataWikilink'], ['dataHref']],
    div: [...(defaultSchema.attributes?.div ?? []), ['className'], ['dataCallout']],
    span: [...(defaultSchema.attributes?.span ?? []), ['className']],
    input: [['type'], ['checked'], ['disabled']],
    img: [...(defaultSchema.attributes?.img ?? []), ['src'], ['alt'], ['dataEmbed']],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
};

const processor = unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, schema as any)
  .use(rehypeStringify);

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico)$/i;

/**
 * Pre-process Obsidian-flavored syntax before markdown parsing:
 *  - ![[image.png]]  → embedded image
 *  - ![[note]]       → embed link (rendered as link for now)
 *  - [[note|alias]]  → internal link
 *  - > [!note] ...   → callout
 */
function preprocess(src: string, rawUrl: (p: string) => string): string {
  // Strip YAML frontmatter (rendered separately as properties, like Obsidian)
  src = src.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  // Embeds first (![[...]])
  src = src.replace(/!\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
    const [target] = inner.split('|');
    const t = target.trim();
    if (IMG_RE.test(t)) return `<img src="${rawUrl(t)}" alt="${esc(t)}" data-embed="1" />`;
    return `<a class="internal-link embed" data-wikilink="${esc(t)}" href="#">${esc(inner)}</a>`;
  });
  // Links [[target|alias]]
  src = src.replace(/\[\[([^\]]+?)\]\]/g, (_m, inner: string) => {
    const [target, alias] = inner.split('|');
    const label = (alias ?? target).trim();
    return `<a class="internal-link" data-wikilink="${esc(target.trim())}" href="#">${esc(label)}</a>`;
  });
  // Callouts: convert "> [!type] Title" blocks
  src = src.replace(
    /^> \[!(\w+)\][ \t]*(.*)$((?:\n> .*)*)/gim,
    (_m, type: string, title: string, rest: string) => {
      const bodyLines = rest
        .split('\n')
        .filter(Boolean)
        .map((l) => l.replace(/^> ?/, ''))
        .join('\n');
      const t = type.toLowerCase();
      return `<div class="callout" data-callout="${esc(t)}"><div class="callout-title">${
        esc(title || t.toUpperCase())
      }</div><div class="callout-content">\n\n${bodyLines}\n\n</div></div>`;
    },
  );
  return src;
}

/** Render leading YAML frontmatter as an Obsidian-like properties block. */
function frontmatterHtml(src: string): string {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return '';
  const rows = m[1]
    .split('\n')
    .map((line) => line.match(/^([\w.-]+):\s*(.*)$/))
    .filter(Boolean)
    .map((mm) => `<div class="prop-row"><span class="prop-key">${esc(mm![1])}</span><span class="prop-val">${esc(mm![2])}</span></div>`)
    .join('');
  return rows ? `<div class="properties">${rows}</div>` : '';
}

export interface RenderOpts {
  rawUrl: (p: string) => string;
  /** Resolve a non-image embed target to its markdown content (transclusion). */
  resolveEmbed?: (target: string) => Promise<{ path: string; content: string } | null>;
}

const IMG_EMBED_RE = /!\[\[([^\]]+?)\]\]/g;

/** Expand `![[note]]` transclusions inline (images are left for preprocess). */
async function expandEmbeds(src: string, opts: RenderOpts, depth: number): Promise<string> {
  if (!opts.resolveEmbed || depth > 3) return src;
  const matches = [...src.matchAll(IMG_EMBED_RE)];
  let out = src;
  for (const m of matches) {
    const target = m[1].split('|')[0].split('#')[0].trim();
    if (IMG_RE.test(target)) continue; // images handled in preprocess
    const note = await opts.resolveEmbed(target);
    if (!note) continue;
    const stripped = note.content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
    const inner = await renderMarkdown(stripped, opts, depth + 1);
    const block = `<div class="embed-note"><div class="embed-title">${esc(target)}</div>${inner}</div>`;
    out = out.replace(m[0], block);
  }
  return out;
}

export async function renderMarkdown(
  src: string,
  opts: RenderOpts,
  depth = 0,
): Promise<string> {
  const props = depth === 0 ? frontmatterHtml(src) : '';
  const expanded = await expandEmbeds(src, opts, depth);
  const pre = preprocess(expanded, opts.rawUrl);
  const file = await processor.process(pre);
  return props + String(file);
}

/** Build an outline (headings) for the outline panel. */
export function outline(src: string): { level: number; text: string }[] {
  const out: { level: number; text: string }[] = [];
  for (const line of src.split('\n')) {
    const m = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (m) out.push({ level: m[1].length, text: m[2] });
  }
  return out;
}
