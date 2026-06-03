import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from '@codemirror/view';
import { StateField, StateEffect, type EditorState, type Range } from '@codemirror/state';
import { syntaxTree } from '@codemirror/language';

/**
 * Live Preview for CodeMirror 6 — an Obsidian-style WYSIWYG editing mode.
 *
 * Formatting is *rendered* (bold is bold, italic italic, code monospaced, headings
 * sized, links/embeds/checkboxes become widgets) while the raw Markdown syntax is
 * concealed. Syntax for a given span is revealed only when the caret is inside
 * THAT span — not the whole paragraph — so editing one word never dumps raw
 * markup across the line. (PRD FR-2)
 */

let openLink: (target: string) => void = () => {};
export function setLivePreviewLinkHandler(fn: (target: string) => void) {
  openLink = fn;
}

/* ---------------- widgets ---------------- */

class WikilinkWidget extends WidgetType {
  constructor(readonly target: string, readonly label: string, readonly embed: boolean) {
    super();
  }
  eq(o: WikilinkWidget) {
    return o.target === this.target && o.label === this.label && o.embed === this.embed;
  }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-wikilink internal-link' + (this.embed ? ' embed' : '');
    a.textContent = this.label;
    a.onmousedown = (e) => {
      e.preventDefault();
      openLink(this.target);
    };
    return a;
  }
  ignoreEvent() {
    return false;
  }
}

class MdLinkWidget extends WidgetType {
  constructor(readonly label: string, readonly href: string) {
    super();
  }
  eq(o: MdLinkWidget) {
    return o.label === this.label && o.href === this.href;
  }
  toDOM() {
    const a = document.createElement('a');
    a.className = 'cm-md-link';
    a.textContent = this.label;
    a.title = this.href;
    const external = /^https?:\/\//i.test(this.href);
    a.onmousedown = (e) => {
      e.preventDefault();
      if (external) window.open(this.href, '_blank', 'noopener');
      else if (this.href.startsWith('#')) { /* in-note anchor — no-op */ }
      else openLink(this.href.replace(/\.(md|markdown)$/i, ''));
    };
    return a;
  }
  ignoreEvent() {
    return false;
  }
}

class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean, readonly pos: number) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView) {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.className = 'cm-task-checkbox';
    box.checked = this.checked;
    box.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ changes: { from: this.pos, to: this.pos + 1, insert: this.checked ? ' ' : 'x' } });
    };
    return box;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(readonly src: string, readonly alt: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.src === this.src;
  }
  toDOM() {
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = this.alt;
    img.className = 'cm-embed-image';
    return img;
  }
}

class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'cm-bullet';
    s.textContent = '•';
    return s;
  }
}

class FrontmatterWidget extends WidgetType {
  constructor(readonly yaml: string) {
    super();
  }
  eq(o: FrontmatterWidget) {
    return o.yaml === this.yaml;
  }
  toDOM() {
    const box = document.createElement('div');
    box.className = 'properties cm-properties';
    // Parse simple YAML: `key: value`, `key: [a, b]`, and multi-line `- item` lists.
    const props: { key: string; values: string[] }[] = [];
    let cur: { key: string; values: string[] } | null = null;
    for (const line of this.yaml.split('\n')) {
      const kv = line.match(/^([\w.-]+):\s*(.*)$/);
      const li = line.match(/^\s*-\s+(.+)$/);
      if (kv) {
        cur = { key: kv[1], values: [] };
        const val = kv[2].trim();
        if (val) {
          const arr = val.match(/^\[(.*)\]$/);
          if (arr) cur.values = arr[1].split(',').map((s) => s.trim()).filter(Boolean);
          else cur.values = [val];
        }
        props.push(cur);
      } else if (li && cur) {
        cur.values.push(li[1].trim());
      }
    }
    for (const p of props) {
      const row = document.createElement('div');
      row.className = 'prop-row';
      const k = document.createElement('span');
      k.className = 'prop-key';
      k.textContent = p.key;
      const v = document.createElement('span');
      v.className = 'prop-val';
      const isList = p.key === 'tags' || p.key === 'aliases' || p.values.length > 1;
      if (isList && p.values.length) {
        for (const val of p.values) {
          const pill = document.createElement('span');
          pill.className = 'prop-pill';
          pill.textContent = val;
          v.appendChild(pill);
        }
      } else {
        v.textContent = p.values.join(', ');
      }
      row.append(k, v);
      box.appendChild(row);
    }
    return box;
  }
}

/* ---------------- helpers ---------------- */

const HEADING_CLASS: Record<string, string> = {
  ATXHeading1: 'cm-h1', ATXHeading2: 'cm-h2', ATXHeading3: 'cm-h3',
  ATXHeading4: 'cm-h4', ATXHeading5: 'cm-h5', ATXHeading6: 'cm-h6',
};

const EMPHASIS_CLASS: Record<string, string> = {
  StrongEmphasis: 'cm-strong',
  Emphasis: 'cm-em',
  InlineCode: 'cm-code',
  Strikethrough: 'cm-strike',
};

const hidden = Decoration.replace({});

function attachmentUrl(target: string): string {
  return `/api/files/content?path=${encodeURIComponent(target)}`;
}

function buildDecorations(view: EditorView): DecorationSet {
  const all: Range<Decoration>[] = [];
  const sel = view.state.selection;
  const doc = view.state.doc;

  // Overlap guard: two content-replacing decorations may not overlap, or CM
  // throws and the whole plugin is disabled. Track claimed replace ranges and
  // skip any new replace that collides. Marks/line decos don't need this.
  const replaced: { from: number; to: number }[] = [];
  const pushReplace = (from: number, to: number, deco: Decoration) => {
    if (from >= to) return;
    for (const r of replaced) if (from < r.to && to > r.from) return;
    replaced.push({ from, to });
    all.push(deco.range(from, to));
  };

  // selection overlaps [from,to] (inclusive) → reveal raw syntax for that span
  const touches = (from: number, to: number) => {
    for (const r of sel.ranges) if (r.from <= to && r.to >= from) return true;
    return false;
  };
  const lineActive = (pos: number) => {
    const line = doc.lineAt(pos);
    return touches(line.from, line.to);
  };

  const tree = syntaxTree(view.state);

  for (const { from, to } of view.visibleRanges) {
    tree.iterate({
      from,
      to,
      enter: (node) => {
        const name = node.name;

        // Headings: size the line; conceal "# " unless caret on the line.
        if (HEADING_CLASS[name]) {
          const line = doc.lineAt(node.from);
          all.push(Decoration.line({ class: HEADING_CLASS[name] }).range(line.from, line.from));
          if (!lineActive(node.from)) {
            const m = doc.sliceString(line.from, line.to).match(/^(#{1,6}\s+)/);
            if (m) pushReplace(line.from, line.from + m[1].length, hidden);
          }
          return;
        }

        // Inline emphasis / code / strikethrough: always style; conceal marks
        // only when the caret is outside the span.
        if (EMPHASIS_CLASS[name]) {
          all.push(Decoration.mark({ class: EMPHASIS_CLASS[name] }).range(node.from, node.to));
          if (!touches(node.from, node.to)) {
            const sn = node.node;
            for (let c = sn.firstChild; c; c = c.nextSibling) {
              if (/Mark$/.test(c.name)) pushReplace(c.from, c.to, hidden);
            }
          }
          return;
        }
      },
    });
  }

  // Regex passes (links, images, wikilinks, tasks, bullets, blockquotes, tags).
  for (const { from, to } of view.visibleRanges) {
    const startLine = doc.lineAt(from).number;
    const endLine = doc.lineAt(to).number;
    for (let ln = startLine; ln <= endLine; ln++) {
      const line = doc.line(ln);
      const text = line.text;

      // Blockquote / callout
      const cq = text.match(/^(>\s?)(\[!(\w+)\][ \t]*)?(.*)$/);
      if (text.startsWith('>') && cq) {
        const calloutType = cq[3]?.toLowerCase();
        all.push(
          Decoration.line({ class: calloutType ? `cm-callout cm-callout-${calloutType}` : 'cm-blockquote' }).range(line.from, line.from),
        );
        if (!lineActive(line.from)) {
          const markLen = cq[1].length + (cq[2]?.length ?? 0);
          pushReplace(line.from, line.from + markLen, hidden);
        }
      }

      // Task checkbox + bullet
      const task = text.match(/^(\s*)([-*+])\s+\[([ xX])\]\s/);
      if (task) {
        const boxPos = line.from + task[1].length + task[2].length + 2;
        if (!touches(line.from, boxPos + 2)) {
          pushReplace(line.from + task[1].length, boxPos + 2, Decoration.replace({ widget: new CheckboxWidget(task[3].toLowerCase() === 'x', boxPos) }));
        }
      } else {
        const bullet = text.match(/^(\s*)([-*+])(\s)/);
        if (bullet && !touches(line.from + bullet[1].length, line.from + bullet[1].length + 1)) {
          pushReplace(line.from + bullet[1].length, line.from + bullet[1].length + 1, Decoration.replace({ widget: new BulletWidget() }));
        }
      }

      // Inline tags → pill styling (#tag)
      const tagRe = /(^|\s)(#[A-Za-z0-9_][\w/-]*)/g;
      let tm: RegExpExecArray | null;
      while ((tm = tagRe.exec(text))) {
        const s = line.from + tm.index + tm[1].length;
        all.push(Decoration.mark({ class: 'cm-tag' }).range(s, s + tm[2].length));
      }

      // Wikilinks / embeds
      const wikiRe = /(!?)\[\[([^\]]+?)\]\]/g;
      let m: RegExpExecArray | null;
      while ((m = wikiRe.exec(text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (touches(s, e)) continue;
        const [target, alias] = m[2].split('|');
        const isEmbed = m[1] === '!';
        if (isEmbed && /\.(png|jpe?g|gif|svg|webp)$/i.test(target.trim())) {
          pushReplace(s, e, Decoration.replace({ widget: new ImageWidget(attachmentUrl(target.trim()), target) }));
        } else {
          pushReplace(s, e, Decoration.replace({ widget: new WikilinkWidget(target.trim(), (alias ?? target).trim(), isEmbed) }));
        }
      }

      // Markdown images ![alt](url) — URL may contain spaces (real-world vaults)
      const imgRe = /!\[([^\]]*)\]\(([^)]+)\)/g;
      while ((m = imgRe.exec(text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (touches(s, e)) continue;
        const alt = m[1];
        const url = m[2].replace(/\s+"[^"]*"$/, '').trim();
        const isHttp = /^https?:\/\//i.test(url);
        const hasScheme = /^[a-z][\w+.-]*:\/\//i.test(url);
        const loadable = isHttp || (!hasScheme && /\.(png|jpe?g|gif|svg|webp|bmp)$/i.test(url));
        if (loadable) {
          const src = /^https?:\/\//i.test(url) ? url : attachmentUrl(url);
          pushReplace(s, e, Decoration.replace({ widget: new ImageWidget(src, alt) }));
        } else {
          // unsupported scheme (e.g. trilium-att://) → compact placeholder link
          const label = alt || url.split('/').pop() || 'image';
          pushReplace(s, e, Decoration.replace({ widget: new MdLinkWidget('🖼 ' + label, url) }));
        }
      }

      // Markdown links [text](url) — not preceded by ! (those are images)
      const linkRe = /(?<!\!)\[([^\]]+?)\]\(([^)]+)\)/g;
      while ((m = linkRe.exec(text))) {
        const s = line.from + m.index;
        const e = s + m[0].length;
        if (touches(s, e)) continue;
        const url = m[2].replace(/\s+"[^"]*"$/, '').trim();
        pushReplace(s, e, Decoration.replace({ widget: new MdLinkWidget(m[1], url) }));
      }
    }
  }

  return Decoration.set(all, true);
}

/* ---------------- frontmatter (block widget; needs a StateField) ---------------- */

function buildFrontmatter(state: EditorState): DecorationSet {
  if (!state.field(livePreviewState, false)) return Decoration.none;
  const text = state.doc.sliceString(0, Math.min(state.doc.length, 4000));
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/);
  if (!fm) return Decoration.none;
  const end = fm[0].length;
  const blockEnd = text[end - 1] === '\n' ? end - 1 : end;
  const fmLineEnd = state.doc.lineAt(blockEnd).to;
  for (const r of state.selection.ranges) if (r.from <= fmLineEnd && r.to >= 0) return Decoration.none;
  return Decoration.set([
    Decoration.replace({ widget: new FrontmatterWidget(fm[1]), block: true }).range(0, blockEnd),
  ]);
}

export const setLivePreviewEnabled = StateEffect.define<boolean>();

export const livePreviewState = StateField.define<boolean>({
  create: () => true,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setLivePreviewEnabled)) return e.value;
    return value;
  },
});

export const frontmatterField = StateField.define<DecorationSet>({
  create: (state) => buildFrontmatter(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection || tr.effects.some((e) => e.is(setLivePreviewEnabled))) {
      return buildFrontmatter(tr.state);
    }
    return value.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const livePreviewPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = view.state.field(livePreviewState) ? buildDecorations(view) : Decoration.none;
    }
    update(u: ViewUpdate) {
      if (!u.state.field(livePreviewState)) {
        this.decorations = Decoration.none;
        return;
      }
      if (u.docChanged || u.selectionSet || u.viewportChanged || u.transactions.some((t) => t.effects.length)) {
        this.decorations = buildDecorations(u.view);
      }
    }
  },
  { decorations: (v) => v.decorations },
);

export const livePreviewTheme = EditorView.baseTheme({
  '.cm-h1': { fontSize: '1.9em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-h2': { fontSize: '1.55em', fontWeight: '700', lineHeight: '1.3' },
  '.cm-h3': { fontSize: '1.3em', fontWeight: '700' },
  '.cm-h4': { fontSize: '1.15em', fontWeight: '700' },
  '.cm-h5': { fontSize: '1.05em', fontWeight: '700' },
  '.cm-h6': { fontSize: '1em', fontWeight: '700', opacity: '0.85' },
  '.cm-strong': { fontWeight: '700' },
  '.cm-em': { fontStyle: 'italic' },
  '.cm-strike': { textDecoration: 'line-through' },
  '.cm-code': {
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-secondary)',
    borderRadius: '4px',
    padding: '0.5px 4px',
    fontSize: '0.88em',
  },
  '.cm-bullet': { color: 'var(--text-faint)' },
  '.cm-tag': {
    background: 'var(--tag-bg)',
    color: 'var(--text-accent)',
    borderRadius: '12px',
    padding: '1px 8px',
    fontSize: '0.85em',
  },
  '.cm-wikilink': { color: 'var(--text-accent)', cursor: 'pointer' },
  '.cm-wikilink:hover': { textDecoration: 'underline' },
  '.cm-md-link': { color: 'var(--text-accent)', cursor: 'pointer', textDecoration: 'none' },
  '.cm-md-link:hover': { textDecoration: 'underline' },
  '.cm-task-checkbox': { verticalAlign: 'middle', marginRight: '4px', cursor: 'pointer' },
  '.cm-embed-image': { maxWidth: '100%', borderRadius: '6px', display: 'block', margin: '6px 0' },
  '.cm-properties': { margin: '4px 0 18px' },
  '.cm-blockquote': {
    borderLeft: '3px solid var(--bg-modifier-border)',
    paddingLeft: '14px',
    color: 'var(--text-muted)',
  },
  '.cm-callout': {
    borderLeft: '3px solid var(--interactive-accent)',
    paddingLeft: '14px',
    background: 'var(--tag-bg)',
  },
  '.cm-callout-tip, .cm-callout-note, .cm-callout-info, .cm-callout-success': {
    borderLeftColor: '#3a9e54',
  },
  '.cm-callout-warning, .cm-callout-caution': { borderLeftColor: '#e0a800' },
  '.cm-callout-danger, .cm-callout-error, .cm-callout-bug': { borderLeftColor: '#e5534b' },
});
