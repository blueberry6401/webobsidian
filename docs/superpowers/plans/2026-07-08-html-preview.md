# HTML Preview (LLM-generated, per-note) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user generate one or more LLM-produced, self-contained HTML "preview" pages bound to a `.md` note, tracked for out-of-sync vs. the note, opened in an in-app tab, generated in the background so a page reload never loses the "generating…" state.

**Architecture:** Express + TS backend adds a `.html-preview/` hidden folder inside the vault (same exclusion pattern as `.trash`) holding a JSON index + per-preview `.html` files, plus new `llm` settings (API keys/provider/templates) in `data/settings.json`. Generation runs as a fire-and-forget async job per preview; status lives on disk so the client can always re-poll it. React + Zustand frontend adds a sentinel tab path (`htmlpreview://<id>`, same pattern as the existing `graph://view` tab), a management dialog (modeled on `ShareDialog`), a tab view with a sandboxed iframe, and a new Settings section.

**Tech Stack:** Node 20 + Express + TypeScript + zod (backend), React 18 + TypeScript + Zustand (frontend), `@anthropic-ai/sdk` + `openai` npm packages (new deps).

## Global Constraints

- Design spec: `docs/superpowers/specs/2026-07-08-html-preview-design.md` — every task below implements a section of it; do not deviate without updating the spec first.
- No automated test framework exists in this repo (confirmed: no `vitest`/`jest`/`"test"` script anywhere). Verification is `npm run typecheck` (fast per-task gate) plus manual curl/browser checks (this project's existing convention — see `IMPLEMENTATION_PLAN.md` entries "verified qua curl + screenshot UI").
- TypeScript: avoid `any` where a real type is easy: prefer it, but this codebase already uses `any` pragmatically for loosely-typed settings blobs on the frontend (e.g. `Settings.tsx`'s `s: any`) — match that existing style, don't over-engineer new strict types where the codebase doesn't.
- Never log or echo API keys. Settings API keys are masked (`••••••••`) on every response, exactly like `git.token` already is.
- `.html-preview/` must be invisible in the file tree, search index, link graph, and filesystem watcher — same as `.trash`/`.obsidian`.
- Feature only applies to `.md` notes (not `.canvas`), and previews are never publicly shared (out of scope per spec §2).
- Commit after each task with a message describing that task only (small, reviewable commits — matches this repo's git history style).
- The API keys for live verification (Task 6 and Task 15) are the two real keys the user already provided earlier in this conversation (Anthropic `sk-ant-api03-...`, OpenAI `sk-proj-...`). Enter them via the running app's Settings UI or a `curl -X PUT /api/settings` call during verification — never hardcode them into any file that gets committed.

---

## Task 1: Add LLM settings (schema, redaction, PUT route) + install SDK deps

**Files:**
- Modify: `server/package.json` (new deps `@anthropic-ai/sdk`, `openai`)
- Modify: `server/src/services/settings.ts`
- Modify: `server/src/routes/settings.ts`

**Interfaces:**
- Produces: `Settings['llm']` shape `{ provider: 'anthropic'|'openai', anthropicApiKey: string, openaiApiKey: string, openaiModel: string, templates: HtmlTemplate[] }`, exported type `HtmlTemplate = { id: string; name: string; prompt: string }`. `redactSettings()` masks `llm.anthropicApiKey`/`llm.openaiApiKey`. `PUT /api/settings` accepts `body.llm` and preserves masked keys (same pattern as `git.token`).
- Consumes: nothing new (this is the foundation task).

- [ ] **Step 1: Install the SDK packages into the server workspace**

Run: `npm install @anthropic-ai/sdk openai --workspace server`
Expected: `server/package.json` dependencies gain `@anthropic-ai/sdk` and `openai` entries; `package-lock.json` updates; command exits 0.

- [ ] **Step 2: Add the `llm` settings group to the zod schema**

In `server/src/services/settings.ts`, add a new schema right above `const SettingsSchema = z.object({`:

```ts
const HtmlTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  prompt: z.string(),
});
```

Inside `SettingsSchema`'s object body, add a new field right after the `api` field (after its closing `.default({}),` and before `ui: z...`):

```ts
  llm: z
    .object({
      provider: z.enum(['anthropic', 'openai']).default('anthropic'),
      anthropicApiKey: z.string().default(''),
      openaiApiKey: z.string().default(''),
      openaiModel: z.string().default('gpt-4o'),
      templates: z.array(HtmlTemplateSchema).default([]),
    })
    .default({}),
```

Right after `export type ApiKeyRecord = z.infer<typeof ApiKeySchema>;`, add:

```ts
export type HtmlTemplate = z.infer<typeof HtmlTemplateSchema>;
```

- [ ] **Step 3: Redact the API keys in `redactSettings()`**

In `server/src/services/settings.ts`, inside the object returned by `redactSettings()`, add a new key right after the `api: { ... }` block (before the closing `};`):

```ts
    llm: {
      ...s.llm,
      anthropicApiKey: s.llm.anthropicApiKey ? '••••••••' : '',
      openaiApiKey: s.llm.openaiApiKey ? '••••••••' : '',
    },
```

- [ ] **Step 4: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0, no errors in `server/src/services/settings.ts`.

- [ ] **Step 5: Wire `llm` into the `PUT /api/settings` route**

In `server/src/routes/settings.ts`, inside the `updateSettings((d) => { ... })` mutator callback (after the existing `if (body.api && ...)` block, before the callback's closing `});`), add:

```ts
      if (body.llm) {
        const { anthropicApiKey, openaiApiKey, ...rest } = body.llm;
        Object.assign(d.llm, rest);
        if (typeof anthropicApiKey === 'string' && anthropicApiKey && anthropicApiKey !== '••••••••') {
          d.llm.anthropicApiKey = anthropicApiKey;
        }
        if (typeof openaiApiKey === 'string' && openaiApiKey && openaiApiKey !== '••••••••') {
          d.llm.openaiApiKey = openaiApiKey;
        }
      }
```

- [ ] **Step 6: Run typecheck again**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add server/package.json package-lock.json server/src/services/settings.ts server/src/routes/settings.ts
git commit -m "feat(html-preview): add llm settings group (provider/keys/templates)"
```

---

## Task 2: LLM client wrapper (`llmclient.ts`)

**Files:**
- Create: `server/src/services/llmclient.ts`

**Interfaces:**
- Consumes: `getSettings()` from `server/src/services/settings.ts:170` (produces `Settings` with `.llm.provider/.anthropicApiKey/.openaiApiKey/.openaiModel`, from Task 1).
- Produces: `export async function generateHtml(noteContent: string, prompt: string): Promise<string>` — throws `Error` (with `.status` set via `Object.assign`, matching this codebase's error convention in `server/src/routes/settings.ts:89`) on missing key or empty LLM response. Later tasks (Task 4) call this directly.

- [ ] **Step 1: Write the module**

Create `server/src/services/llmclient.ts`:

```ts
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { getSettings } from './settings.js';

// Undated alias — Anthropic keeps this pointed at the newest Sonnet snapshot,
// so this file never needs a manual bump when a new Claude model ships.
const ANTHROPIC_MODEL = 'claude-sonnet-4-5';

const SYSTEM_PROMPT = `You generate a single, self-contained, standalone HTML file that previews the content of an Obsidian-style markdown note for a human to skim quickly.

Rules:
- Output ONLY raw HTML. No markdown code fences, no explanation before or after.
- The file must be fully self-contained: inline all CSS and JavaScript. Do not reference external stylesheets, scripts, or fonts that require network access.
- Plain <a href="..."> links (e.g. to Google Maps, external sites) are fine and encouraged when the user's instructions call for them.
- Make the layout clean, readable, and easy to skim at a glance.
- Base the content strictly on the note's markdown content given below, following the user's instructions for how to present it.`;

/** Strip a ```html ... ``` (or bare ``` ... ```) fence if the model wrapped its output in one. */
function extractHtml(raw: string): string {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/^```(?:html)?\s*\n?([\s\S]*?)\n?```$/i);
  return (fenced ? fenced[1] : trimmed).trim();
}

async function generateAnthropic(apiKey: string, userContent: string): Promise<string> {
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: ANTHROPIC_MODEL,
    max_tokens: 8192,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = msg.content.map((b) => ('text' in b ? b.text : '')).join('\n');
  return text;
}

async function generateOpenAI(apiKey: string, model: string, userContent: string): Promise<string> {
  const client = new OpenAI({ apiKey });
  const completion = await client.chat.completions.create({
    model: model || 'gpt-4o',
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
  });
  return completion.choices[0]?.message?.content ?? '';
}

export async function generateHtml(noteContent: string, prompt: string): Promise<string> {
  const s = await getSettings();
  const userContent = `${prompt}\n\n--- Note content (Markdown) ---\n${noteContent}`;

  let text: string;
  if (s.llm.provider === 'anthropic') {
    if (!s.llm.anthropicApiKey) {
      throw Object.assign(new Error('Chưa cấu hình Anthropic API key. Vào Settings → AI để thêm.'), { status: 400 });
    }
    text = await generateAnthropic(s.llm.anthropicApiKey, userContent);
  } else {
    if (!s.llm.openaiApiKey) {
      throw Object.assign(new Error('Chưa cấu hình OpenAI API key. Vào Settings → AI để thêm.'), { status: 400 });
    }
    text = await generateOpenAI(s.llm.openaiApiKey, s.llm.openaiModel, userContent);
  }

  if (!text.trim()) {
    throw Object.assign(new Error('LLM trả về nội dung rỗng, thử lại.'), { status: 502 });
  }
  return extractHtml(text);
}
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0. If the installed `@anthropic-ai/sdk` or `openai` version has a different type shape than assumed here (e.g. `msg.content` block union field names), fix the type error using the actual installed types — check `node_modules/@anthropic-ai/sdk/resources/messages.d.ts` and `node_modules/openai/resources/chat/completions.d.ts` if needed.

- [ ] **Step 3: Smoke-test the code-fence stripper in isolation**

Run: `npx tsx -e "
import { generateHtml } from './server/src/services/llmclient.js';
" 2>&1 | head -5`
Expected: no import-time syntax errors printed (module loads). This only validates the file parses/imports cleanly — the real generation call is exercised end-to-end in Task 6.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/llmclient.ts
git commit -m "feat(html-preview): add provider-agnostic LLM HTML generation client"
```

---

## Task 3: `.html-preview` vault storage service

**Files:**
- Create: `server/src/services/htmlpreview.ts`

**Interfaces:**
- Consumes: `vault.readFileText`, `vault.writeFileText`, `vault.exists`, `vault.remove` from `server/src/services/vault.ts` (existing); `generateHtml` from `server/src/services/llmclient.ts` (Task 2).
- Produces: `HtmlPreviewRecord` type `{ id, notePath, name, templateId: string|null, prompt, status: 'generating'|'done'|'error', error: string|null, sourceHash: string|null, createdAt, updatedAt }`; functions `listPreviews(notePath)`, `getPreview(id)`, `getPreviewHtml(id)`, `currentOutOfSync(record)`, `createPreview(opts)`, `regeneratePreview(id)`, `renamePreview(id, name)`, `deletePreview(id)`, `sweepInterruptedOnBoot()`. Consumed by Task 4 (routes) and Task 5 (server boot).

- [ ] **Step 1: Write the service**

Create `server/src/services/htmlpreview.ts`:

```ts
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Smoke-test the pure logic with a throwaway script**

Run:
```bash
npx tsx -e "
import { createHash } from 'node:crypto';
const a = createHash('sha256').update('hello').digest('hex');
const b = createHash('sha256').update('hello').digest('hex');
const c = createHash('sha256').update('world').digest('hex');
if (a !== b) throw new Error('same content must hash the same');
if (a === c) throw new Error('different content must hash differently');
console.log('hash logic OK');
"
```
Expected output: `hash logic OK`.

- [ ] **Step 4: Commit**

```bash
git add server/src/services/htmlpreview.ts
git commit -m "feat(html-preview): add vault-backed preview storage + background generation"
```

---

## Task 4: `htmlpreview` routes

**Files:**
- Create: `server/src/routes/htmlpreview.ts`

**Interfaces:**
- Consumes: `listPreviews, getPreview, getPreviewHtml, createPreview, regeneratePreview, renamePreview, deletePreview, currentOutOfSync, type HtmlPreviewRecord` from `server/src/services/htmlpreview.ts` (Task 3); `getSettings, updateSettings` from `server/src/services/settings.ts` (Task 1); `vault.exists` from `server/src/services/vault.ts`; `requireAuth` from `server/src/middleware/auth.ts`; `asyncHandler` from `server/src/middleware/error.ts`.
- Produces: `export const htmlPreviewRouter: Router` with `GET /` (query `notePath`), `POST /`, `GET /:id`, `POST /:id/regenerate`, `PATCH /:id`, `DELETE /:id`. Consumed by Task 5 (mounting in `index.ts`).

- [ ] **Step 1: Write the routes**

Create `server/src/routes/htmlpreview.ts`:

```ts
import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { asyncHandler } from '../middleware/error.js';
import { requireAuth } from '../middleware/auth.js';
import * as vault from '../services/vault.js';
import { getSettings, updateSettings } from '../services/settings.js';
import {
  listPreviews,
  getPreview,
  getPreviewHtml,
  createPreview,
  regeneratePreview,
  renamePreview,
  deletePreview,
  currentOutOfSync,
  type HtmlPreviewRecord,
} from '../services/htmlpreview.js';

const isMd = (p: string) => /\.(md|markdown)$/i.test(p);

async function toDto(r: HtmlPreviewRecord) {
  return { ...r, outOfSync: await currentOutOfSync(r) };
}

export const htmlPreviewRouter = Router();
htmlPreviewRouter.use(requireAuth);

htmlPreviewRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const notePath = String(req.query.notePath ?? '');
    if (!notePath) {
      res.status(400).json({ error: 'notePath required' });
      return;
    }
    const records = await listPreviews(notePath);
    res.json({ previews: await Promise.all(records.map(toDto)) });
  }),
);

htmlPreviewRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const notePath = String(req.body?.notePath ?? '');
    if (!notePath || !isMd(notePath)) {
      res.status(400).json({ error: 'notePath to a .md note required' });
      return;
    }
    if (!(await vault.exists(notePath))) {
      res.status(404).json({ error: 'note not found' });
      return;
    }
    const templateId = req.body?.templateId ? String(req.body.templateId) : null;
    let prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    let name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    if (templateId) {
      const s = await getSettings();
      const tpl = s.llm.templates.find((t) => t.id === templateId);
      if (!tpl) {
        res.status(404).json({ error: 'template not found' });
        return;
      }
      prompt = tpl.prompt;
      if (!name) name = tpl.name;
    }
    if (!prompt) {
      res.status(400).json({ error: 'prompt or templateId required' });
      return;
    }
    if (!name) name = prompt.length > 40 ? `${prompt.slice(0, 40)}…` : prompt;

    const saveAsTemplate = req.body?.saveAsTemplate;
    if (saveAsTemplate && typeof saveAsTemplate.name === 'string' && saveAsTemplate.name.trim()) {
      await updateSettings((d) => {
        d.llm.templates.push({ id: randomBytes(8).toString('hex'), name: saveAsTemplate.name.trim(), prompt });
      });
    }

    const record = await createPreview({ notePath, templateId, prompt, name });
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const record = await getPreview(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    const html = record.status === 'done' ? await getPreviewHtml(record.id) : null;
    res.json({ preview: await toDto(record), html });
  }),
);

htmlPreviewRouter.post(
  '/:id/regenerate',
  asyncHandler(async (req, res) => {
    const record = await regeneratePreview(req.params.id);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name) {
      res.status(400).json({ error: 'name required' });
      return;
    }
    const record = await renamePreview(req.params.id, name);
    if (!record) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ preview: await toDto(record) });
  }),
);

htmlPreviewRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const ok = await deletePreview(req.params.id);
    if (!ok) {
      res.status(404).json({ error: 'preview not found' });
      return;
    }
    res.json({ ok: true });
  }),
);
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add server/src/routes/htmlpreview.ts
git commit -m "feat(html-preview): add /api/html-preview CRUD + regenerate routes"
```

---

## Task 5: Wire into server bootstrap (mount router, ignore folder, sweep on boot)

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `htmlPreviewRouter` from `server/src/routes/htmlpreview.ts` (Task 4); `sweepInterruptedOnBoot` from `server/src/services/htmlpreview.ts` (Task 3).
- Produces: running server exposes `/api/html-preview/*`; `.html-preview/` is invisible to the chokidar watcher; any interrupted generation is marked `error` on boot.

- [ ] **Step 1: Add the imports**

In `server/src/index.ts`, add these two lines to the import block (near the other route imports, e.g. right after `import { sharePageRouter } from './routes/sharepage.js';`):

```ts
import { htmlPreviewRouter } from './routes/htmlpreview.js';
import { sweepInterruptedOnBoot } from './services/htmlpreview.js';
```

- [ ] **Step 2: Mount the router**

In `server/src/index.ts`, find the route-registration block:

```ts
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...
```

Add a new line right before the broad `/api` search router (which must stay last, per the existing comment above this block):

```ts
  app.use('/api/shares', sharesRouter); // manage public share links (auth)
  app.use('/public/shares', publicSharesRouter); // shared-note content (NO auth)
  app.use('/share', sharePageRouter); // SSR public share page (NO auth, SEO/OG meta)
  app.use('/api/html-preview', htmlPreviewRouter); // LLM-generated HTML previews (auth)
  app.use('/api', searchRouter); // /api/search, /api/tags, /api/backlinks, /api/graph...
```

- [ ] **Step 3: Sweep interrupted generations on boot**

In `server/src/index.ts`, find:

```ts
  await loadSettings();
  await setPasswordIfInitial();
  await ensureVault();
```

Change it to:

```ts
  await loadSettings();
  await setPasswordIfInitial();
  await ensureVault();
  await sweepInterruptedOnBoot();
```

- [ ] **Step 4: Hide `.html-preview` from the filesystem watcher**

In `server/src/index.ts`, find:

```ts
    ignored: (p) => /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash)([/\\]|$)/.test(p),
```

Change to:

```ts
    ignored: (p) => /(^|[/\\])(\.git|\.obsidian|node_modules|\.trash|\.html-preview)([/\\]|$)/.test(p),
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Verify the tree/link-index/search-index already hide dot-folders (no code change expected)**

Run: `grep -n "startsWith('.')" server/src/services/vault.ts server/src/services/fileindex.ts`
Expected: at least 2 matches (one in `vault.ts`'s `listTree`, one in `vault.ts`'s `listMarkdownFiles`, one in `fileindex.ts`) confirming the generic dot-prefix exclusion already covers `.html-preview` with no further code changes.

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(html-preview): mount router, sweep interrupted jobs on boot, hide from watcher"
```

---

## Task 6: Backend live verification (curl, real API keys)

**Files:** none (verification only).

**Interfaces:** none — this task exercises Tasks 1–5 end-to-end before building the frontend.

- [ ] **Step 1: Start the dev server**

Run (background): `npm run dev:server`
Expected: log line `WebObsidian server → http://0.0.0.0:8787` (or similar), no crash.

- [ ] **Step 2: Log in and capture the session cookie**

Run:
```bash
curl -sc /tmp/wo-cookies.txt -X POST http://localhost:8787/auth/login -H 'Content-Type: application/json' -d '{"password":"123456"}'
```
Expected: JSON with `"ok":true` (or a `mustChangePassword` field) — status 200.

- [ ] **Step 3: Configure the Anthropic API key via settings**

Run (substitute the real Anthropic key the user provided earlier in this conversation):
```bash
curl -sb /tmp/wo-cookies.txt -X PUT http://localhost:8787/api/settings/ -H 'Content-Type: application/json' \
  -d '{"llm":{"provider":"anthropic","anthropicApiKey":"<ANTHROPIC_KEY>"}}'
```
Expected: JSON response where `llm.anthropicApiKey` is `"••••••••"` (masked) and `llm.provider` is `"anthropic"`.

- [ ] **Step 4: Create a preview on the sample vault's README/first note**

Run:
```bash
curl -sb /tmp/wo-cookies.txt -X POST http://localhost:8787/api/html-preview/ -H 'Content-Type: application/json' \
  -d '{"notePath":"<pick any .md path that exists under sample-vault/, e.g. via GET /api/files/>","prompt":"Tóm tắt nội dung note này thành 1 trang HTML đơn giản, dễ đọc."}'
```
Expected: JSON `{"preview":{"id":"...","status":"generating",...}}`. Note the `id`.

- [ ] **Step 5: Poll until done**

Run (repeat every ~3s, substituting `<ID>`):
```bash
curl -sb /tmp/wo-cookies.txt http://localhost:8787/api/html-preview/<ID>
```
Expected: `status` transitions from `"generating"` to `"done"`, and `html` becomes a non-empty string starting with `<` (raw HTML, no markdown fence). If `status` becomes `"error"`, read `preview.error` — a real Anthropic API error (bad key, no credit) is acceptable to report to the user, but a code bug (e.g. TypeScript logic error) must be fixed before continuing.

- [ ] **Step 6: Verify out-of-sync detection**

Run: `curl -sb /tmp/wo-cookies.txt -X PUT http://localhost:8787/api/files/content -H 'Content-Type: application/json' -d '{"path":"<same notePath>","content":"changed content"}'`
then: `curl -sb /tmp/wo-cookies.txt http://localhost:8787/api/html-preview/<ID>`
Expected: `preview.outOfSync` is now `true`.

- [ ] **Step 7: Regenerate, rename, delete**

Run:
```bash
curl -sb /tmp/wo-cookies.txt -X POST http://localhost:8787/api/html-preview/<ID>/regenerate
curl -sb /tmp/wo-cookies.txt -X PATCH http://localhost:8787/api/html-preview/<ID> -H 'Content-Type: application/json' -d '{"name":"Renamed preview"}'
curl -sb /tmp/wo-cookies.txt -X DELETE http://localhost:8787/api/html-preview/<ID>
```
Expected: regenerate returns `status:"generating"` again (poll again to confirm it re-completes with an updated `sourceHash`); rename returns `preview.name === "Renamed preview"`; delete returns `{"ok":true}`, and a following `GET /api/html-preview/<ID>` returns 404.

- [ ] **Step 8: Confirm `.html-preview/` is invisible in the tree API**

Run: `curl -sb /tmp/wo-cookies.txt http://localhost:8787/api/files/ | grep -o '.html-preview' || echo "NOT FOUND (expected)"`
Expected: prints `NOT FOUND (expected)`.

- [ ] **Step 9: Repeat with the OpenAI key to confirm the other provider path works**

Run:
```bash
curl -sb /tmp/wo-cookies.txt -X PUT http://localhost:8787/api/settings/ -H 'Content-Type: application/json' \
  -d '{"llm":{"provider":"openai","openaiApiKey":"<OPENAI_KEY>","openaiModel":"gpt-4o"}}'
curl -sb /tmp/wo-cookies.txt -X POST http://localhost:8787/api/html-preview/ -H 'Content-Type: application/json' \
  -d '{"notePath":"<same or another .md path>","prompt":"Tóm tắt ngắn gọn."}'
```
Poll the returned id the same way as Step 5. Expected: eventually `status:"done"` with non-empty `html`.

- [ ] **Step 10: No commit for this task** (verification only — nothing to commit). Stop the dev server (`Ctrl-C` / kill the background job) before moving on.

---

## Task 7: Frontend API client + types

**Files:**
- Modify: `web/src/lib/api.ts`

**Interfaces:**
- Produces: types `HtmlTemplate`, `HtmlPreviewRecord` (frontend mirrors of the backend DTOs from Tasks 1 & 3/4, including the extra `outOfSync: boolean` field the route layer adds); `api.listHtmlPreviews`, `api.createHtmlPreview`, `api.getHtmlPreview`, `api.regenerateHtmlPreview`, `api.renameHtmlPreview`, `api.deleteHtmlPreview`. Consumed by Task 9 (store), Task 10 (dialog), Task 11 (tab view).
- Consumes: existing `req<T>()` helper, existing `ApiError` class (both already in this file).

- [ ] **Step 1: Add the types**

In `web/src/lib/api.ts`, add right after the `export interface GitCommit { ... }` block:

```ts
export interface HtmlTemplate {
  id: string;
  name: string;
  prompt: string;
}

export interface HtmlPreviewRecord {
  id: string;
  notePath: string;
  name: string;
  templateId: string | null;
  prompt: string;
  status: 'generating' | 'done' | 'error';
  error: string | null;
  sourceHash: string | null;
  createdAt: string;
  updatedAt: string;
  outOfSync: boolean;
}
```

- [ ] **Step 2: Add the API functions**

In `web/src/lib/api.ts`, add a new block right after the `// plugins` block at the end of the `api` object (before the final closing `};`):

```ts

  // html preview (LLM-generated, per-note)
  listHtmlPreviews: (notePath: string) =>
    req<{ previews: HtmlPreviewRecord[] }>(`/api/html-preview/?notePath=${encodeURIComponent(notePath)}`),
  createHtmlPreview: (body: {
    notePath: string;
    templateId?: string | null;
    prompt?: string;
    name?: string;
    saveAsTemplate?: { name: string };
  }) => req<{ preview: HtmlPreviewRecord }>('/api/html-preview/', { method: 'POST', body: JSON.stringify(body) }),
  getHtmlPreview: (id: string) =>
    req<{ preview: HtmlPreviewRecord; html: string | null }>(`/api/html-preview/${id}`),
  regenerateHtmlPreview: (id: string) =>
    req<{ preview: HtmlPreviewRecord }>(`/api/html-preview/${id}/regenerate`, { method: 'POST' }),
  renameHtmlPreview: (id: string, name: string) =>
    req<{ preview: HtmlPreviewRecord }>(`/api/html-preview/${id}`, { method: 'PATCH', body: JSON.stringify({ name }) }),
  deleteHtmlPreview: (id: string) => req<{ ok: true }>(`/api/html-preview/${id}`, { method: 'DELETE' }),
```

Note: the very last existing entry in the `api` object (`setPluginEnabled`) currently ends the object with `};` on its own line two lines later — make sure the new block is inserted as an additional comma-separated property, not after the closing brace.

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/api.ts
git commit -m "feat(html-preview): add frontend API client functions + types"
```

---

## Task 8: `file-code` icon

**Files:**
- Modify: `web/src/components/Icon.tsx`

**Interfaces:**
- Produces: new icon name `'file-code'` usable via `<Icon name="file-code" />` everywhere. Consumed by Task 10, 11, 12.

- [ ] **Step 1: Add the glyph**

In `web/src/components/Icon.tsx`, inside the `PATHS` object, add a new entry right after the existing `'file-pdf': ...,` line (same file-body shape as `'file-pdf'`, reused for visual consistency, with a small `<>`-style code glyph instead of the PDF glyph):

```ts
  'file-code': '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="m10 13-2 2 2 2"/><path d="m14 13 2 2-2 2"/>',
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/Icon.tsx
git commit -m "feat(html-preview): add file-code icon"
```

---

## Task 9: Store — sentinel tab path + dialog state + open action

**Files:**
- Modify: `web/src/lib/store.ts`

**Interfaces:**
- Consumes: existing `GRAPH_PATH` pattern, `pushHistory`, `Tab` type (all already in this file).
- Produces: `HTML_PREVIEW_PREFIX`, `isHtmlPreviewPath(path): boolean`, `htmlPreviewTabPath(id): string`, `htmlPreviewIdFromPath(path): string` (module-level exports); store fields `htmlPreviewDialogPath: string | null`, `setHtmlPreviewDialog(path)`, `openHtmlPreview(id, title): Promise<void>`. Consumed by Task 10 (dialog), Task 11 (tab view), Task 12 (Workspace wiring).

- [ ] **Step 1: Add the sentinel-path helpers**

In `web/src/lib/store.ts`, right after `export const GRAPH_PATH = 'graph://view';`, add:

```ts
/** Sentinel tab path scheme for an HTML Preview tab (same pattern as GRAPH_PATH). */
export const HTML_PREVIEW_PREFIX = 'htmlpreview://';
export const isHtmlPreviewPath = (path: string): boolean => path.startsWith(HTML_PREVIEW_PREFIX);
export const htmlPreviewTabPath = (id: string): string => `${HTML_PREVIEW_PREFIX}${id}`;
export const htmlPreviewIdFromPath = (path: string): string => path.slice(HTML_PREVIEW_PREFIX.length);
```

- [ ] **Step 2: Add the state fields to `AppState`**

In `web/src/lib/store.ts`, inside the `AppState` interface, right after:

```ts
  /** Note path whose Share dialog is open (null = closed). */
  shareDialogPath: string | null;
  setShareDialog: (path: string | null) => void;
```

add:

```ts
  /** Note path whose HTML Preview dialog is open (null = closed). */
  htmlPreviewDialogPath: string | null;
  setHtmlPreviewDialog: (path: string | null) => void;
  /** Open (or focus) an HTML preview's tab, given its id + display title. */
  openHtmlPreview: (id: string, title: string) => Promise<void>;
```

- [ ] **Step 3: Implement the state + action**

In `web/src/lib/store.ts`, inside the `create<AppState>()(...)` body, right after:

```ts
      shareDialogPath: null,
      setShareDialog: (path) => set({ shareDialogPath: path }),
```

add:

```ts
      htmlPreviewDialogPath: null,
      setHtmlPreviewDialog: (path) => set({ htmlPreviewDialogPath: path }),
      openHtmlPreview: async (id, title) => {
        if (get().dirty) await get().save();
        const path = htmlPreviewTabPath(id);
        set((s) => ({
          tabs: s.tabs.some((t) => t.path === path) ? s.tabs : [...s.tabs, { path, title }],
          activePath: path,
          content: '',
          dirty: false,
          ...pushHistory(s, path),
        }));
      },
```

- [ ] **Step 4: Special-case htmlpreview paths in `openFile`**

In `web/src/lib/store.ts`, find:

```ts
      openFile: async (path) => {
        if (path === GRAPH_PATH) return get().openGraph();
        if (get().dirty) await get().save();
```

Change to:

```ts
      openFile: async (path) => {
        if (path === GRAPH_PATH) return get().openGraph();
        if (isHtmlPreviewPath(path)) {
          if (get().dirty) await get().save();
          set((s) => ({ activePath: path, content: '', dirty: false, ...pushHistory(s, path) }));
          return;
        }
        if (get().dirty) await get().save();
```

- [ ] **Step 5: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/store.ts
git commit -m "feat(html-preview): add sentinel tab path helpers + dialog/open state"
```

---

## Task 10: `HtmlPreviewDialog` component

**Files:**
- Create: `web/src/components/HtmlPreviewDialog.tsx`

**Interfaces:**
- Consumes: `useStore` fields `htmlPreviewDialogPath`, `setHtmlPreviewDialog`, `openHtmlPreview`, `notify` (Task 9); `api.listHtmlPreviews`, `api.createHtmlPreview`, `api.renameHtmlPreview`, `api.deleteHtmlPreview`, `api.getSettings`, types `HtmlPreviewRecord`, `HtmlTemplate` (Task 7); `Icon` (Task 8, `file-code`/`pencil`/`trash`/`plus`).
- Produces: `export default function HtmlPreviewDialog()`. Consumed by Task 13 (`App.tsx`).

- [ ] **Step 1: Write the component**

Create `web/src/components/HtmlPreviewDialog.tsx`:

```tsx
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/HtmlPreviewDialog.tsx
git commit -m "feat(html-preview): add HtmlPreviewDialog (list/create/rename/delete)"
```

---

## Task 11: `HtmlPreviewView` component (the tab content)

**Files:**
- Create: `web/src/components/HtmlPreviewView.tsx`

**Interfaces:**
- Consumes: `api.getHtmlPreview`, `api.regenerateHtmlPreview`, type `HtmlPreviewRecord` (Task 7); `useStore((s) => s.notify)`; `Icon` (`refresh-cw`, Task 8's `file-code` not needed here).
- Produces: `export default function HtmlPreviewView({ previewId }: { previewId: string })`. Consumed by Task 12 (`Workspace.tsx`).

- [ ] **Step 1: Write the component**

Create `web/src/components/HtmlPreviewView.tsx`:

```tsx
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
```

- [ ] **Step 2: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/HtmlPreviewView.tsx
git commit -m "feat(html-preview): add HtmlPreviewView tab (polling + sandboxed iframe)"
```

---

## Task 12: Wire into `Workspace.tsx`

**Files:**
- Modify: `web/src/components/Workspace.tsx`

**Interfaces:**
- Consumes: `isHtmlPreviewPath`, `htmlPreviewIdFromPath` (Task 9); `HtmlPreviewView` (Task 11); `setHtmlPreviewDialog` (Task 9, via `useStore`).
- Produces: menu item "HTML Preview…" on `.md` panes; tab bar icon for htmlpreview tabs; main content area renders `HtmlPreviewView` for htmlpreview tabs; the pane's crumbs/More-options button no longer misbehave on htmlpreview tabs.

- [ ] **Step 1: Update imports**

In `web/src/components/Workspace.tsx`, change:

```ts
import { useStore, GRAPH_PATH, type ContextMenuItem } from '../lib/store';
```

to:

```ts
import { useStore, GRAPH_PATH, isHtmlPreviewPath, htmlPreviewIdFromPath, type ContextMenuItem } from '../lib/store';
```

And add a new import right after `import CanvasView from './CanvasView';`:

```ts
import HtmlPreviewView from './HtmlPreviewView';
```

- [ ] **Step 2: Grab the dialog setter**

In `web/src/components/Workspace.tsx`, right after:

```ts
  const setShareDialog = useStore((s) => s.setShareDialog);
```

add:

```ts
  const setHtmlPreviewDialog = useStore((s) => s.setHtmlPreviewDialog);
```

- [ ] **Step 3: Add the menu item**

In `web/src/components/Workspace.tsx`, find:

```ts
        ...(isShareable ? [{ label: 'Share…', icon: 'globe', onClick: () => setShareDialog(path) }] : []),
```

Change to:

```ts
        ...(isShareable ? [{ label: 'Share…', icon: 'globe', onClick: () => setShareDialog(path) }] : []),
        ...(isMd ? [{ label: 'HTML Preview…', icon: 'file-code', onClick: () => setHtmlPreviewDialog(path) }] : []),
```

- [ ] **Step 4: Tab bar icon**

In `web/src/components/Workspace.tsx`, find:

```tsx
              {t.path === GRAPH_PATH && (
                <Icon name="graph" size={13} style={{ marginRight: 4, flexShrink: 0 }} />
              )}
```

Change to:

```tsx
              {t.path === GRAPH_PATH && (
                <Icon name="graph" size={13} style={{ marginRight: 4, flexShrink: 0 }} />
              )}
              {isHtmlPreviewPath(t.path) && (
                <Icon name="file-code" size={13} style={{ marginRight: 4, flexShrink: 0 }} />
              )}
```

- [ ] **Step 5: Crumbs**

In `web/src/components/Workspace.tsx`, find:

```tsx
          <span className="crumbs">
            {activePath === GRAPH_PATH
              ? 'Graph view'
              : activePath.split('/').map((seg, i) => (
                  <span key={i}>
                    {i > 0 && <span className="sep">/</span>}
                    {seg.replace(/\.(md|markdown)$/, '')}
                  </span>
                ))}
          </span>
```

Change to:

```tsx
          <span className="crumbs">
            {activePath === GRAPH_PATH
              ? 'Graph view'
              : isHtmlPreviewPath(activePath)
                ? (tabs.find((t) => t.path === activePath)?.title ?? 'HTML Preview')
                : activePath.split('/').map((seg, i) => (
                    <span key={i}>
                      {i > 0 && <span className="sep">/</span>}
                      {seg.replace(/\.(md|markdown)$/, '')}
                    </span>
                  ))}
          </span>
```

- [ ] **Step 6: Hide the More-options button for htmlpreview tabs**

In `web/src/components/Workspace.tsx`, find:

```tsx
          {!activeIsFolder && (
            <button className="tool-btn" title="More options" onClick={openMoreMenu}>
              <Icon name="more-horizontal" size={18} />
            </button>
          )}
```

Change to:

```tsx
          {!activeIsFolder && !isHtmlPreviewPath(activePath) && (
            <button className="tool-btn" title="More options" onClick={openMoreMenu}>
              <Icon name="more-horizontal" size={18} />
            </button>
          )}
```

- [ ] **Step 7: Main content dispatch**

In `web/src/components/Workspace.tsx`, find:

```tsx
        {activePath === GRAPH_PATH && (
          <div className="pane main-pane">
            <GraphView />
          </div>
        )}
        {activePath && activePath !== GRAPH_PATH && activeIsFolder && (
          <div className="pane main-pane">
            <FolderView path={activePath} />
          </div>
        )}
        {activePath && activePath !== GRAPH_PATH && !activeIsFolder && (
          <div className="pane main-pane">
            <EditorPane />
          </div>
        )}
```

Change to:

```tsx
        {activePath === GRAPH_PATH && (
          <div className="pane main-pane">
            <GraphView />
          </div>
        )}
        {activePath && isHtmlPreviewPath(activePath) && (
          <div className="pane main-pane">
            <HtmlPreviewView previewId={htmlPreviewIdFromPath(activePath)} />
          </div>
        )}
        {activePath && activePath !== GRAPH_PATH && !isHtmlPreviewPath(activePath) && activeIsFolder && (
          <div className="pane main-pane">
            <FolderView path={activePath} />
          </div>
        )}
        {activePath && activePath !== GRAPH_PATH && !isHtmlPreviewPath(activePath) && !activeIsFolder && (
          <div className="pane main-pane">
            <EditorPane />
          </div>
        )}
```

- [ ] **Step 8: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/Workspace.tsx
git commit -m "feat(html-preview): wire HTML Preview into Workspace (menu, tab, pane dispatch)"
```

---

## Task 13: Wire `HtmlPreviewDialog` into `App.tsx`

**Files:**
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `HtmlPreviewDialog` (Task 10).
- Produces: dialog is mounted app-wide (same pattern as `ShareDialog`).

- [ ] **Step 1: Add the import**

In `web/src/App.tsx`, change:

```ts
import ShareDialog from './components/ShareDialog';
```

to:

```ts
import ShareDialog from './components/ShareDialog';
import HtmlPreviewDialog from './components/HtmlPreviewDialog';
```

- [ ] **Step 2: Render it**

In `web/src/App.tsx`, change:

```tsx
      <Settings />
      <ShareDialog />
      <VersionHistory />
```

to:

```tsx
      <Settings />
      <ShareDialog />
      <HtmlPreviewDialog />
      <VersionHistory />
```

- [ ] **Step 3: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add web/src/App.tsx
git commit -m "feat(html-preview): mount HtmlPreviewDialog in App"
```

---

## Task 14: Settings → "AI" section (provider/keys/model + template CRUD)

**Files:**
- Modify: `web/src/components/Settings.tsx`

**Interfaces:**
- Consumes: `api.putSettings`, `api.getSettings` (existing); `Row`, `Icon` (existing helpers in this file).
- Produces: new Settings tab "AI" that edits `llm.provider`/`anthropicApiKey`/`openaiApiKey`/`openaiModel` and CRUDs `llm.templates` — the templates this Settings section manages are exactly what `HtmlPreviewDialog` (Task 10) reads via `api.getSettings().llm.templates`.

- [ ] **Step 1: Add `'ai'` to the `Section` type**

In `web/src/components/Settings.tsx`, change:

```ts
type Section = 'vault' | 'git' | 'api' | 'sharing' | 'plugins' | 'appearance' | 'account' | 'about';
```

to:

```ts
type Section = 'vault' | 'git' | 'api' | 'sharing' | 'ai' | 'plugins' | 'appearance' | 'account' | 'about';
```

- [ ] **Step 2: Add it to the nav array**

In `web/src/components/Settings.tsx`, change:

```tsx
            {(['vault', 'git', 'api', 'sharing', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
```

to:

```tsx
            {(['vault', 'git', 'api', 'sharing', 'ai', 'plugins', 'appearance', 'account', 'about'] as Section[]).map((s) => (
```

- [ ] **Step 3: Render the section**

In `web/src/components/Settings.tsx`, change:

```tsx
            {section === 'sharing' && <Shares />}
            {section === 'plugins' && <Plugins />}
```

to:

```tsx
            {section === 'sharing' && <Shares />}
            {settings && section === 'ai' && <AiSettings s={settings} reload={() => api.getSettings().then(setSettings)} />}
            {section === 'plugins' && <Plugins />}
```

- [ ] **Step 4: Add the label**

In `web/src/components/Settings.tsx`, change:

```ts
const labels: Record<Section, string> = {
  vault: 'Vault & Files',
  git: 'GitHub Sync',
  api: 'API Keys',
  sharing: 'Sharing',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  account: 'Account',
  about: 'About',
};
```

to:

```ts
const labels: Record<Section, string> = {
  vault: 'Vault & Files',
  git: 'GitHub Sync',
  api: 'API Keys',
  sharing: 'Sharing',
  ai: 'AI',
  plugins: 'Community Plugins',
  appearance: 'Appearance',
  account: 'Account',
  about: 'About',
};
```

- [ ] **Step 5: Add the `AiSettings` component**

In `web/src/components/Settings.tsx`, add this new function right after the `Shares()` function's closing `}` (before `function Plugins() {`):

```tsx
function AiSettings({ s, reload }: { s: any; reload: () => void }) {
  const [llm, setLlm] = useState({ ...s.llm });
  const set = (k: string, v: any) => setLlm((p: any) => ({ ...p, [k]: v }));
  const save = async () => {
    // Only patch the non-template fields — templates are saved separately below
    // (via saveTemplates), so this must NOT resend a stale `llm.templates` snapshot.
    await api.putSettings({
      llm: { provider: llm.provider, anthropicApiKey: llm.anthropicApiKey, openaiApiKey: llm.openaiApiKey, openaiModel: llm.openaiModel },
    });
    await reload();
  };

  const [templates, setTemplates] = useState<any[]>(s.llm.templates ?? []);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  const saveTemplates = async (next: any[]) => {
    setTemplates(next);
    await api.putSettings({ llm: { templates: next } });
    await reload();
  };
  const addTemplate = async () => {
    if (!newName.trim() || !newPrompt.trim()) return;
    const id = Math.random().toString(36).slice(2, 10);
    await saveTemplates([...templates, { id, name: newName.trim(), prompt: newPrompt.trim() }]);
    setNewName('');
    setNewPrompt('');
  };
  const updateTemplate = async (id: string, patch: any) => {
    await saveTemplates(templates.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };
  const removeTemplate = async (id: string) => {
    if (!confirm('Xoá template này?')) return;
    await saveTemplates(templates.filter((t) => t.id !== id));
  };

  return (
    <div>
      <h2>AI — HTML Preview</h2>
      <p style={{ color: 'var(--text-muted)' }}>
        Cấu hình LLM dùng để sinh bản HTML preview cho note (menu ⋯ → "HTML Preview…").
      </p>
      <Row name="Provider">
        <select className="text-input" value={llm.provider} onChange={(e) => set('provider', e.target.value)}>
          <option value="anthropic">Anthropic (Claude)</option>
          <option value="openai">OpenAI</option>
        </select>
      </Row>
      <Row name="Anthropic API key" desc="Luôn dùng model Claude Sonnet mới nhất, không cần chọn tên model">
        <input className="text-input" type="password" style={{ width: 320 }} value={llm.anthropicApiKey} onChange={(e) => set('anthropicApiKey', e.target.value)} />
      </Row>
      <Row name="OpenAI API key">
        <input className="text-input" type="password" style={{ width: 320 }} value={llm.openaiApiKey} onChange={(e) => set('openaiApiKey', e.target.value)} />
      </Row>
      <Row name="OpenAI model" desc="Tên model OpenAI dùng khi provider = OpenAI">
        <input className="text-input" style={{ width: 200 }} value={llm.openaiModel} onChange={(e) => set('openaiModel', e.target.value)} />
      </Row>
      <button className="btn" onClick={save}>Save</button>

      <h3 style={{ marginTop: 24 }}>Templates</h3>
      {templates.length === 0 && <div style={{ color: 'var(--text-faint)' }}>Chưa có template nào.</div>}
      {templates.map((t) => (
        <div className="setting-row" key={t.id}>
          <div className="info" style={{ minWidth: 0 }}>
            {editingId === t.id ? (
              <>
                <input
                  className="text-input"
                  style={{ width: '100%', marginBottom: 4 }}
                  value={t.name}
                  onChange={(e) => setTemplates((p) => p.map((x) => (x.id === t.id ? { ...x, name: e.target.value } : x)))}
                />
                <textarea
                  className="text-input"
                  style={{ width: '100%', height: 70, boxSizing: 'border-box' }}
                  value={t.prompt}
                  onChange={(e) => setTemplates((p) => p.map((x) => (x.id === t.id ? { ...x, prompt: e.target.value } : x)))}
                />
              </>
            ) : (
              <>
                <div className="name">{t.name}</div>
                <div className="desc" style={{ whiteSpace: 'pre-wrap' }}>{t.prompt}</div>
              </>
            )}
          </div>
          <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
            {editingId === t.id ? (
              <button className="btn" onClick={() => { updateTemplate(t.id, { name: t.name, prompt: t.prompt }); setEditingId(null); }}>Save</button>
            ) : (
              <button className="btn secondary" onClick={() => setEditingId(t.id)}><Icon name="pencil" size={14} /></button>
            )}
            <button className="btn danger" onClick={() => removeTemplate(t.id)}><Icon name="trash" size={14} /></button>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 10 }}>
        <input className="text-input" style={{ width: '100%', marginBottom: 6 }} placeholder="Tên template mới" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <textarea className="text-input" style={{ width: '100%', height: 70, boxSizing: 'border-box', marginBottom: 6 }} placeholder="Nội dung prompt…" value={newPrompt} onChange={(e) => setNewPrompt(e.target.value)} />
        <button className="btn" onClick={addTemplate}>+ Thêm template</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Run typecheck**

Run: `npm run typecheck`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add web/src/components/Settings.tsx
git commit -m "feat(html-preview): add Settings → AI section (provider/keys/model + templates CRUD)"
```

---

## Task 15: CSS for the new dialog/tab

**Files:**
- Modify: `web/src/styles/obsidian.css`

**Interfaces:** none — pure styling, no exports.

- [ ] **Step 1: Add the styles**

In `web/src/styles/obsidian.css`, right after the existing block:

```css
.share-dialog-foot { display: flex; justify-content: flex-end; margin-top: 12px; }
```

add:

```css

.html-preview-dialog .setting-row { align-items: flex-start; }
.html-preview-view { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.html-preview-toolbar { display: flex; align-items: center; gap: 10px; padding: 8px 14px; border-bottom: 1px solid var(--bg-modifier-border); flex-shrink: 0; }
.html-preview-frame-wrap { flex: 1; min-height: 0; }
.html-preview-frame { width: 100%; height: 100%; border: 0; background: #fff; display: block; }
.html-preview-badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; background: var(--bg-secondary); color: var(--text-muted); }
.html-preview-badge.generating { color: var(--text-accent, #7b6cd9); }
.html-preview-badge.error { color: #e5534b; background: rgba(229, 83, 75, .12); }
.html-preview-badge.outofsync { color: #d9822b; background: rgba(217, 130, 43, .12); }
```

- [ ] **Step 2: Commit**

```bash
git add web/src/styles/obsidian.css
git commit -m "feat(html-preview): add CSS for preview dialog/tab"
```

---

## Task 16: Full manual E2E verification (real browser, both providers)

**Files:** none (verification only). Per this repo's `CLAUDE.md`: "chạy 1 real end-to-end test as an actual user" before handing off — this task is that test.

**Interfaces:** none — exercises the entire feature built in Tasks 1–15.

- [ ] **Step 1: Build and start the full stack**

Run: `npm run build && npm run start`
Expected: build succeeds (web + server), server starts and logs its URL.

- [ ] **Step 2: Log in as a real user in a browser**

Open `http://localhost:8787` (or the configured host/port), log in with the vault password.
Expected: normal app shell loads.

- [ ] **Step 3: Configure both API keys in Settings → AI**

Open Settings → AI, set provider to Anthropic, paste the Anthropic key, Save. Then switch provider to OpenAI, paste the OpenAI key, confirm/adjust the model field (default `gpt-4o`), Save.
Expected: after reopening Settings → AI, both key fields show `••••••••` (masked), never the raw key.

- [ ] **Step 4: Add a template**

In Settings → AI → Templates, add one named e.g. "Lộ trình di chuyển" with prompt "Đây là lộ trình di chuyển, tạo file html để preview nhanh chóng, giúp tôi liếc qua là nắm được lộ trình + bấm vào ra Google Maps link luôn."
Expected: template appears in the list immediately.

- [ ] **Step 5: Generate a preview from a note using the template**

Open any `.md` note with some travel/itinerary-style content (or any note — content doesn't have to match the template's theme for this smoke test). Menu ⋯ → "HTML Preview…" → "+ Tạo preview mới" → pick the template from the dropdown → Generate.
Expected: dialog closes, a new tab opens immediately showing "Đang tạo…"/generating state.

- [ ] **Step 6: Reload the page while it's still generating**

While the tab still shows "Đang tạo…", hit browser refresh (F5).
Expected: after reload, the app restores the same tab and it still shows "Đang tạo…" (not lost, not stuck blank) — then within the polling interval transitions to the finished HTML render. This is the core reload-survival requirement from the spec.

- [ ] **Step 7: Verify the rendered HTML**

Expected: the iframe shows a rendered HTML page (not raw text, not a code fence). If the note had any URLs relevant to the prompt, confirm links are clickable and open in a new tab/window (target of a plain `<a href>` inside a sandboxed iframe without `allow-popups` — if links fail to open, note this as a finding, but it is not a blocker for this task since `allow-scripts`-only sandboxing intentionally restricts more than that; report the observed behavior).

- [ ] **Step 8: Verify out-of-sync**

Switch to the note tab, edit its text, save (⌘S or auto-save). Switch back to the preview tab.
Expected: the badge changes to "Lệch với note" ("out of sync").

- [ ] **Step 9: Regenerate**

Click "Tạo lại" in the preview tab.
Expected: badge goes to "Đang tạo…", then back to "Đã đồng bộ" ("synced") once done.

- [ ] **Step 10: Multiple previews on the same note**

From the same note, open "HTML Preview…" again, create a second preview with a different ad-hoc prompt (not a template), and check "Lưu thành template" with a new name.
Expected: dialog now lists 2 previews with distinct names; the new template appears in Settings → AI → Templates afterward.

- [ ] **Step 11: Rename and delete**

In the dialog, rename one preview inline, delete the other.
Expected: rename updates the visible name immediately; delete removes the row and the corresponding tab (if open) should be closed manually by the user — note whether leaving a stale open tab after delete is confusing; if so, this is an acceptable known gap for v1 (not in spec scope) but should be mentioned in the final report.

- [ ] **Step 12: Missing-key error path**

In Settings → AI, clear both API key fields (leave provider set to one of them), Save. Try to generate a new preview.
Expected: the preview's status becomes `error` with a message telling the user to configure the API key in Settings.

- [ ] **Step 13: Confirm `.html-preview/` never appears in the file tree**

Look at the file tree sidebar throughout all of the above.
Expected: no `.html-preview` folder or file is ever visible.

- [ ] **Step 14: No commit for this task** (verification only). Report the outcome of Steps 1–13 to the user, including any deviations found (e.g. Step 7's link-click caveat, Step 11's stale-tab caveat) — do not silently fix scope-creep issues; note them for a follow-up if they're real problems, but they are not blockers unless something in the spec itself was violated.

---

## Task 17: Sync PRD.md and IMPLEMENTATION_PLAN.md

**Files:**
- Modify: `PRD.md`
- Modify: `IMPLEMENTATION_PLAN.md`

**Interfaces:** none — documentation only, per this repo's `CLAUDE.md` requirement to keep PRD/plan in sync with shipped scope.

- [ ] **Step 1: Add a new FR to PRD.md**

In `PRD.md`, add a new `### FR-14 · HTML Preview (LLM-generated, per-note)` section right after the closing of `### FR-13 · Desktop app...` (i.e. right before the `---` that precedes `## 4. Yêu cầu phi chức năng (NFR)`):

```markdown
### FR-14 · HTML Preview (LLM-generated, per-note)
Mục tiêu: cho phép tạo **bản xem trước HTML** cho một note `.md`, sinh bởi LLM (Anthropic Claude
hoặc OpenAI) dựa trên nội dung note + một prompt hướng dẫn. Không phải export tĩnh 1-lần: HTML
được gắn với note gốc, hiển thị trạng thái **out-of-sync** khi note đổi, và tạo lại được bất cứ
lúc nào. Một note có thể có **nhiều bản preview** khác nhau (mỗi bản ứng với 1 prompt/template).

- **Cấu hình LLM**: Settings → AI — chọn provider (Anthropic/OpenAI), API key riêng cho từng
  provider (che sau khi lưu, giống token Git), model OpenAI có thể chỉnh (mặc định `gpt-4o`),
  Anthropic luôn dùng alias Claude Sonnet mới nhất (không cho chỉnh). Danh sách **template prompt**
  (tên + nội dung) quản lý CRUD ngay trong cùng trang.
- **Trigger**: menu "⋯" của pane note đang mở (chỉ với file `.md`) → "HTML Preview…" → hộp thoại
  liệt kê preview đã có (tên, trạng thái, out-of-sync), Rename/Delete từng dòng, "+ Tạo preview
  mới" (chọn template có sẵn hoặc gõ prompt tuỳ ý, tuỳ chọn lưu thành template).
- **Xử lý nền + polling**: bấm Generate trả về ngay bản ghi trạng thái `generating` (ghi đĩa trước
  khi gọi LLM) — **reload trang giữa chừng vẫn khôi phục đúng trạng thái** (client poll lại). Server
  khởi động lại giữa lúc đang generate → job dở dang tự chuyển `error` thay vì treo vĩnh viễn.
- **Lưu trữ**: preview lưu trong thư mục ẩn `.html-preview/` ngay trong vault (cùng quy ước ẩn với
  `.trash` — tự động không hiện trong file tree/search/link graph/watcher). Mỗi bản ghi gồm note
  nào, tên, prompt/template dùng, trạng thái, "dấu vân tay" (hash) nội dung note tại lần tạo thành
  công gần nhất (để tính out-of-sync).
- **Xem preview**: mở trong tab riêng của app (sentinel path `htmlpreview://<id>`, giống cách
  Graph view dùng `graph://view`), nội dung render trong `<iframe sandbox="allow-scripts">` (cách
  ly khỏi cookie/session app — phòng LLM sinh mã độc hại). Badge trạng thái + nút "Tạo lại" ngay
  trong tab.
- **Phạm vi (non-goals) v1**: không share public bản preview (khác "Share…"); không áp dụng cho
  `.canvas`.

API mới: `GET/POST /api/html-preview`, `GET/POST /api/html-preview/{id}`, `POST
/api/html-preview/{id}/regenerate`, `PATCH/DELETE /api/html-preview/{id}`. Settings mới nhóm `llm`
(`provider`, `anthropicApiKey`, `openaiApiKey`, `openaiModel`, `templates[]`).
```

- [ ] **Step 2: Bump the PRD changelog header**

In `PRD.md`, change the version line:

```
> Phiên bản: 1.5 · Cập nhật: 2026-06-22 · Trạng thái: Draft
```

to:

```
> Phiên bản: 1.6 · Cập nhật: 2026-07-08 · Trạng thái: Draft
```

and add a new changelog paragraph right after that line (before the existing `> Changelog 1.5 (...)`):

```
> Changelog 1.6 (FR-14 — HTML Preview LLM-generated, theo yêu cầu người dùng): note `.md` có thể có
> nhiều bản **HTML preview** sinh bởi LLM (Anthropic/OpenAI), gắn với note gốc (không phải export
> tĩnh), báo **out-of-sync** khi note đổi, tạo lại được. Xử lý nền + polling (bấm Generate trả về
> ngay, reload trang giữa chừng vẫn khôi phục đúng trạng thái). Lưu trong thư mục ẩn
> `.html-preview/` trong vault (cùng quy ước ẩn với `.trash`). Xem trong tab riêng, iframe sandbox
> cách ly session app. Settings mới nhóm `llm` (provider/API keys/model/template prompt CRUD).
```

- [ ] **Step 3: Add the new milestone to IMPLEMENTATION_PLAN.md**

In `IMPLEMENTATION_PLAN.md`, add a new phase right after the end of `## Phase 27 — Desktop app...` (i.e. right before the `### Nhật ký tiến độ` heading):

```markdown
## Phase 28 — HTML Preview (LLM-generated, per-note) — FR-14 (theo yêu cầu người dùng)
- [x] M28.1 Settings `llm` group (provider/API keys masked/openaiModel/templates CRUD) — schema +
      redaction + `PUT /api/settings` (`server/src/services/settings.ts`, `server/src/routes/settings.ts`)
- [x] M28.2 `llmclient.ts`: provider-agnostic `generateHtml()` (Anthropic Claude Sonnet alias / OpenAI,
      configurable model), strips markdown code fences from the LLM response
- [x] M28.3 `.html-preview/` vault-hidden storage (`htmlpreview.ts` service): index.json + per-preview
      `.html` files, background generation (fire-and-forget), sweep-interrupted-on-boot, out-of-sync
      via sha256 content hash
- [x] M28.4 Routes `/api/html-preview` (list/create/get/regenerate/rename/delete); mounted + watcher
      ignore + boot sweep wired into `server/src/index.ts`
- [x] M28.5 Frontend: sentinel tab path `htmlpreview://<id>` (store.ts, same pattern as `graph://view`),
      `HtmlPreviewDialog` (list/create/rename/delete per note), `HtmlPreviewView` tab (status badge +
      polling + sandboxed iframe), wired into Workspace ⋯ menu + tab bar + pane dispatch
- [x] M28.6 Settings → AI section: provider/API keys/model + template prompt CRUD
- [x] M28.7 End-to-end verify với API key thật (Anthropic + OpenAI): tạo preview, reload giữa lúc
      đang generate vẫn khôi phục đúng trạng thái, out-of-sync badge, tạo lại, nhiều preview/note,
      rename/delete, thiếu key báo lỗi rõ, `.html-preview/` không lộ ra file tree/search/watcher
```

(Only flip these to `[x]` once Task 16's verification actually passed — if any step in Task 16 failed and was fixed, still `[x]` once green; if a non-blocking caveat was found, still `[x]` but mention the caveat in the progress log entry below.)

- [ ] **Step 4: Update "Cập nhật lần cuối" and add a progress log entry**

In `IMPLEMENTATION_PLAN.md`, change:

```
Cập nhật lần cuối: 2026-06-27 (security fix — chặn leo thang quyền token share; merge fix F-03 rate-limit, giữ `trust proxy` mặc định bật)
```

to:

```
Cập nhật lần cuối: 2026-07-08 (FR-14 — HTML Preview LLM-generated per-note)
```

Then add a new entry at the very end of the `### Nhật ký tiến độ` list (after the last existing bullet):

```
- 2026-07-08: Phase 28 (PRD 1.6, FR-14) — HTML Preview LLM-generated per-note. Note `.md` có thể có
  nhiều bản HTML preview (Anthropic/OpenAI, template prompt tái sử dụng), gắn với note gốc + báo
  out-of-sync qua sha256 hash, xử lý nền + polling (reload giữa lúc generate vẫn khôi phục đúng
  trạng thái nhờ trạng thái ghi đĩa trước khi gọi LLM; server restart giữa chừng → job dở dang tự
  thành error thay vì treo). Lưu trong `.html-preview/` ẩn trong vault (cùng quy ước `.trash`, không
  cần sửa gì ở tree/search/link-index — chỉ thêm 1 entry vào regex ignore của watcher). Xem trong
  tab riêng (`htmlpreview://<id>`, cùng pattern `graph://view`), `<iframe sandbox="allow-scripts">`
  cách ly session app khỏi HTML do LLM sinh. Settings → AI: provider/API key (che sau khi lưu)/model
  OpenAI/CRUD template. Verify: tạo preview + reload giữa chừng + out-of-sync + regenerate + nhiều
  preview/note + rename/delete + thiếu key báo lỗi, dùng API key thật của cả 2 provider. Typecheck +
  build sạch.
```

- [ ] **Step 5: Commit**

```bash
git add PRD.md IMPLEMENTATION_PLAN.md
git commit -m "docs: sync PRD.md + IMPLEMENTATION_PLAN.md for FR-14 (HTML Preview)"
```
