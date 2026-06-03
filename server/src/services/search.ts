import { promises as fs } from 'node:fs';
import MiniSearch from 'minisearch';
import { getSettings } from './settings.js';
import { INDEX_FILE, config } from '../config.js';
import { listMarkdownFiles, readFileText } from './vault.js';
import { parseNote } from './markdown.js';

/**
 * QMD — the WebObsidian search engine.
 * A thin, opinionated layer over MiniSearch giving fielded, fuzzy, prefix and
 * boolean queries over the vault's markdown, with incremental updates and a
 * persisted on-disk index for fast cold starts. (PRD FR-7)
 */

interface QmdDoc {
  id: string; // vault-relative path
  title: string;
  headings: string;
  tags: string;
  path: string;
  body: string;
}

export interface SearchHit {
  path: string;
  title: string;
  score: number;
  tags: string[];
  snippet: string;
}

const FIELDS = ['title', 'headings', 'tags', 'path', 'body'] as const;

class QmdEngine {
  private mini: MiniSearch<QmdDoc>;
  private snippets = new Map<string, string>();
  private tagSet = new Map<string, string[]>();
  private ready = false;

  constructor() {
    this.mini = this.newIndex();
  }

  private newIndex() {
    return new MiniSearch<QmdDoc>({
      fields: FIELDS as unknown as string[],
      storeFields: ['title', 'path', 'tags'],
      searchOptions: {
        boost: { title: 4, headings: 2, tags: 3 },
        prefix: true,
        fuzzy: 0.2,
      },
    });
  }

  private async toDoc(rel: string): Promise<QmdDoc> {
    const raw = await readFileText(rel);
    const note = parseNote(rel, raw);
    const snippet = note.body.replace(/\s+/g, ' ').trim().slice(0, 280);
    this.snippets.set(rel, snippet);
    this.tagSet.set(rel, note.tags);
    return {
      id: rel,
      title: note.title,
      headings: note.headings.join(' '),
      tags: note.tags.join(' '),
      path: rel,
      body: note.body,
    };
  }

  /** Full (re)build from the vault. */
  async build(): Promise<void> {
    const files = await listMarkdownFiles();
    this.mini = this.newIndex();
    this.snippets.clear();
    this.tagSet.clear();
    const docs: QmdDoc[] = [];
    for (const rel of files) {
      try {
        docs.push(await this.toDoc(rel));
      } catch {
        /* skip unreadable */
      }
    }
    this.mini.addAll(docs);
    this.ready = true;
    await this.persist();
  }

  async upsert(rel: string): Promise<void> {
    if (!/\.(md|markdown)$/i.test(rel)) return;
    try {
      const doc = await this.toDoc(rel);
      if (this.mini.has(rel)) this.mini.replace(doc);
      else this.mini.add(doc);
    } catch {
      this.remove(rel);
    }
  }

  remove(rel: string): void {
    if (this.mini.has(rel)) this.mini.discard(rel);
    this.snippets.delete(rel);
    this.tagSet.delete(rel);
  }

  async rename(from: string, to: string): Promise<void> {
    this.remove(from);
    await this.upsert(to);
  }

  async search(query: string, limit = 30): Promise<SearchHit[]> {
    if (!this.ready) await this.build();
    const s = await getSettings();
    const { filterText, fields } = parseFielded(query);

    const opts: Record<string, unknown> = {
      prefix: s.search.prefix,
      fuzzy: s.search.fuzzy,
      boost: { title: 4, headings: 2, tags: 3 },
    };
    if (fields.length) opts.fields = fields;

    const q = filterText.trim() || query.trim();
    const results = q ? this.mini.search(q, opts) : [];

    return results.slice(0, limit).map((r) => ({
      path: r.id as string,
      title: (r as any).title ?? r.id,
      score: r.score,
      tags: this.tagSet.get(r.id as string) ?? [],
      snippet: this.snippets.get(r.id as string) ?? '',
    }));
  }

  allTags(): { tag: string; count: number }[] {
    const counts = new Map<string, number>();
    for (const tags of this.tagSet.values()) {
      for (const t of tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);
  }

  private async persist(): Promise<void> {
    try {
      await fs.mkdir(config.dataDir, { recursive: true });
      const payload = {
        mini: this.mini.toJSON(),
        snippets: [...this.snippets.entries()],
        tags: [...this.tagSet.entries()],
      };
      await fs.writeFile(INDEX_FILE, JSON.stringify(payload));
    } catch {
      /* non-fatal */
    }
  }

  async restore(): Promise<boolean> {
    try {
      const raw = await fs.readFile(INDEX_FILE, 'utf8');
      const payload = JSON.parse(raw);
      this.mini = MiniSearch.loadJSON<QmdDoc>(JSON.stringify(payload.mini), {
        fields: FIELDS as unknown as string[],
        storeFields: ['title', 'path', 'tags'],
      });
      this.snippets = new Map(payload.snippets);
      this.tagSet = new Map(payload.tags);
      this.ready = true;
      return true;
    } catch {
      return false;
    }
  }

  async save(): Promise<void> {
    await this.persist();
  }
}

/** Pull `field:` qualifiers out of a query into MiniSearch field filters. */
function parseFielded(query: string): { filterText: string; fields: string[] } {
  const fieldMap: Record<string, string> = {
    tag: 'tags',
    tags: 'tags',
    title: 'title',
    path: 'path',
    heading: 'headings',
  };
  const fields = new Set<string>();
  const rest: string[] = [];
  for (const tok of query.split(/\s+/)) {
    const m = tok.match(/^(\w+):(.+)$/);
    if (m && fieldMap[m[1].toLowerCase()]) {
      fields.add(fieldMap[m[1].toLowerCase()]);
      rest.push(m[2]);
    } else {
      rest.push(tok);
    }
  }
  return { filterText: rest.join(' '), fields: [...fields] };
}

export const qmd = new QmdEngine();

/** Initialize the engine: restore from disk or build fresh. */
export async function initSearch(): Promise<void> {
  const restored = await qmd.restore();
  if (!restored) await qmd.build();
}
