import path from 'node:path';
import { listMarkdownFiles, readFileText } from './vault.js';
import { parseNote, linkKey } from './markdown.js';

interface LinkGraph {
  /** outgoing[rel] = set of target keys */
  outgoing: Map<string, Set<string>>;
  /** keyToPath[linkKey] = rel path (for resolving wikilinks to files) */
  keyToPath: Map<string, string>;
}

let graph: LinkGraph = { outgoing: new Map(), keyToPath: new Map() };

export async function buildLinkGraph(): Promise<void> {
  const files = await listMarkdownFiles();
  const outgoing = new Map<string, Set<string>>();
  const keyToPath = new Map<string, string>();

  for (const rel of files) {
    const base = path.basename(rel).replace(/\.(md|markdown)$/i, '').toLowerCase();
    keyToPath.set(base, rel);
    keyToPath.set(rel.replace(/\.(md|markdown)$/i, '').toLowerCase(), rel);
  }

  for (const rel of files) {
    try {
      const note = parseNote(rel, await readFileText(rel));
      outgoing.set(rel, new Set(note.links.map(linkKey)));
    } catch {
      outgoing.set(rel, new Set());
    }
  }
  graph = { outgoing, keyToPath };
}

export function resolveLink(target: string): string | undefined {
  return graph.keyToPath.get(linkKey(target));
}

/** Notes that link *to* the given vault-relative path. */
export function backlinksFor(rel: string): string[] {
  const targetKey = path.basename(rel).replace(/\.(md|markdown)$/i, '').toLowerCase();
  const relKey = rel.replace(/\.(md|markdown)$/i, '').toLowerCase();
  const out: string[] = [];
  for (const [source, targets] of graph.outgoing) {
    if (source === rel) continue;
    if (targets.has(targetKey) || targets.has(relKey)) out.push(source);
  }
  return out.sort();
}

export interface GraphData {
  nodes: { id: string; label: string }[];
  edges: { source: string; target: string }[];
}

export function graphData(): GraphData {
  const nodes: { id: string; label: string }[] = [];
  const edges: { source: string; target: string }[] = [];
  for (const rel of graph.outgoing.keys()) {
    nodes.push({ id: rel, label: path.basename(rel).replace(/\.(md|markdown)$/i, '') });
  }
  for (const [source, targets] of graph.outgoing) {
    for (const t of targets) {
      const dest = graph.keyToPath.get(t);
      if (dest) edges.push({ source, target: dest });
    }
  }
  return { nodes, edges };
}
