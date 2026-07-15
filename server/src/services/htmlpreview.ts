import { randomBytes, createHash } from 'node:crypto';
import * as vault from './vault.js';
import { generateHtml } from './llmclient.js';

export type HtmlPreviewStatus = 'generating' | 'done' | 'error';

/**
 * One LLM-generated HTML preview bound to a note. A note can have several of
 * these (one per prompt/template). Stored inside the vault (hidden dot-folder,
 * same exclusion pattern as .trash) so it travels with the vault.
 */
export interface HtmlPreviewRecord {
  id: string;
  notePath: string;
  name: string;
  templateId: string | null;
  /** Resolved prompt text used to generate this preview — frozen at creation, reused by regenerate. */
  prompt: string;
  status: HtmlPreviewStatus;
  error: string | null;
  /** sha256 of the note's content at the last successful generation; null until first success. */
  sourceHash: string | null;
  createdAt: string;
  updatedAt: string;
}

const INDEX_PATH = '.html-preview/index.json';
const htmlPath = (id: string) => `.html-preview/${id}.html`;

let cache: HtmlPreviewRecord[] | null = null;

async function load(): Promise<HtmlPreviewRecord[]> {
  if (cache) return cache;
  try {
    const raw = await vault.readFileText(INDEX_PATH);
    const parsed = JSON.parse(raw);
    cache = Array.isArray(parsed)
      ? parsed.filter(
          (r): r is HtmlPreviewRecord => r && typeof r.id === 'string' && typeof r.notePath === 'string',
        )
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(records: HtmlPreviewRecord[]): Promise<void> {
  cache = records;
  await vault.writeFileText(INDEX_PATH, JSON.stringify(records, null, 2));
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

export async function listPreviews(notePath: string): Promise<HtmlPreviewRecord[]> {
  return (await load()).filter((r) => r.notePath === notePath);
}

export async function getPreview(id: string): Promise<HtmlPreviewRecord | null> {
  return (await load()).find((r) => r.id === id) ?? null;
}

export async function getPreviewHtml(id: string): Promise<string | null> {
  try {
    return await vault.readFileText(htmlPath(id));
  } catch {
    return null;
  }
}

/** True only for a successfully-generated preview whose note has changed since. */
export async function currentOutOfSync(record: HtmlPreviewRecord): Promise<boolean> {
  if (record.status !== 'done' || !record.sourceHash) return false;
  try {
    const content = await vault.readFileText(record.notePath);
    return hashContent(content) !== record.sourceHash;
  } catch {
    return false;
  }
}

export async function createPreview(opts: {
  notePath: string;
  templateId: string | null;
  prompt: string;
  name: string;
}): Promise<HtmlPreviewRecord> {
  const now = new Date().toISOString();
  const record: HtmlPreviewRecord = {
    id: randomBytes(8).toString('hex'),
    notePath: opts.notePath,
    name: opts.name,
    templateId: opts.templateId,
    prompt: opts.prompt,
    status: 'generating',
    error: null,
    sourceHash: null,
    createdAt: now,
    updatedAt: now,
  };
  const records = await load();
  records.push(record);
  await persist(records);
  void runGeneration(record.id);
  return record;
}

export async function regeneratePreview(id: string): Promise<HtmlPreviewRecord | null> {
  const records = await load();
  const record = records.find((r) => r.id === id);
  if (!record) return null;
  record.status = 'generating';
  record.error = null;
  record.updatedAt = new Date().toISOString();
  await persist(records);
  void runGeneration(id);
  return record;
}

export async function renamePreview(id: string, name: string): Promise<HtmlPreviewRecord | null> {
  const records = await load();
  const record = records.find((r) => r.id === id);
  if (!record) return null;
  record.name = name;
  record.updatedAt = new Date().toISOString();
  await persist(records);
  return record;
}

export async function deletePreview(id: string): Promise<boolean> {
  const records = await load();
  const next = records.filter((r) => r.id !== id);
  if (next.length === records.length) return false;
  await persist(next);
  await vault.remove(htmlPath(id)).catch(() => {});
  return true;
}

/** Called once at server boot: a preview stuck "generating" from a killed process becomes an error instead of hanging forever. */
export async function sweepInterruptedOnBoot(): Promise<void> {
  const records = await load();
  let dirty = false;
  for (const r of records) {
    if (r.status === 'generating') {
      r.status = 'error';
      r.error = 'Bị gián đoạn do server khởi động lại, vui lòng thử lại.';
      r.updatedAt = new Date().toISOString();
      dirty = true;
    }
  }
  if (dirty) await persist(records);
}

/** Fire-and-forget background generation. Never throws — writes the outcome onto the record. */
async function runGeneration(id: string): Promise<void> {
  const records = await load();
  const record = records.find((r) => r.id === id);
  if (!record) return;
  try {
    if (!(await vault.exists(record.notePath))) {
      throw new Error('Note không còn tồn tại.');
    }
    const noteContent = await vault.readFileText(record.notePath);
    const html = await generateHtml(noteContent, record.prompt);
    await vault.writeFileText(htmlPath(id), html);
    record.status = 'done';
    record.error = null;
    record.sourceHash = hashContent(noteContent);
  } catch (e: any) {
    record.status = 'error';
    record.error = e?.message ?? 'Tạo HTML thất bại';
  }
  record.updatedAt = new Date().toISOString();
  await persist(records);
}
