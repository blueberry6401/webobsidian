import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { config, SETTINGS_FILE } from '../config.js';

/** ---- Schema (PRD §6) ---------------------------------------------------- */

const ApiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  hash: z.string(),
  prefix: z.string(), // first chars, for display
  scopes: z.array(z.enum(['read', 'write', 'search'])).default(['read', 'search']),
  createdAt: z.string(),
  lastUsed: z.string().nullable().default(null),
});

const SettingsSchema = z.object({
  version: z.number().default(1),
  auth: z
    .object({
      passwordHash: z.string().default(''),
      jwtSecret: z.string().default(''),
    })
    .default({}),
  vault: z
    .object({
      path: z.string().default(''),
      allowedRoots: z.array(z.string()).default([]),
      trash: z.string().default('.trash'),
      attachmentDir: z.string().default('attachments'),
    })
    .default({}),
  git: z
    .object({
      enabled: z.boolean().default(false),
      remote: z.string().default(''),
      branch: z.string().default('main'),
      token: z.string().default(''),
      authorName: z.string().default('WebObsidian'),
      authorEmail: z.string().default('webobsidian@localhost'),
      autoSync: z.boolean().default(false),
      autoCommitOnSave: z.boolean().default(false),
      intervalSec: z.number().default(300),
      lfsPatterns: z
        .array(z.string())
        .default(['*.png', '*.jpg', '*.jpeg', '*.gif', '*.pdf', '*.mp4', '*.mov', '*.zip']),
    })
    .default({}),
  search: z
    .object({
      fuzzy: z.number().default(0.2),
      prefix: z.boolean().default(true),
      indexFrontmatter: z.boolean().default(true),
    })
    .default({}),
  api: z
    .object({
      keys: z.array(ApiKeySchema).default([]),
      rateLimitPerMin: z.number().default(120),
    })
    .default({}),
  ui: z
    .object({
      theme: z.enum(['obsidian-dark', 'obsidian-light']).default('obsidian-light'),
      defaultView: z.enum(['live', 'source', 'reading']).default('live'),
    })
    .default({}),
  plugins: z
    .object({
      enabled: z.array(z.string()).default([]),
      installed: z.array(z.string()).default([]),
    })
    .default({}),
});

export type Settings = z.infer<typeof SettingsSchema>;
export type ApiKeyRecord = z.infer<typeof ApiKeySchema>;

/** ---- Store --------------------------------------------------------------- */

let cache: Settings | null = null;

function defaults(): Settings {
  const base = SettingsSchema.parse({});
  base.auth.jwtSecret = randomBytes(48).toString('hex');
  base.vault.path = config.defaultVaultPath;
  base.vault.allowedRoots = config.allowedRoots.length
    ? config.allowedRoots
    : [path.dirname(config.defaultVaultPath), config.defaultVaultPath];
  return base;
}

async function ensureDataDir(): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true });
}

/** Atomic write: write to tmp then rename; keep a .bak of the previous file. */
async function persist(s: Settings): Promise<void> {
  await ensureDataDir();
  const json = JSON.stringify(s, null, 2);
  const tmp = `${SETTINGS_FILE}.tmp-${randomBytes(4).toString('hex')}`;
  await fs.writeFile(tmp, json, { mode: 0o600 });
  try {
    await fs.copyFile(SETTINGS_FILE, `${SETTINGS_FILE}.bak`);
  } catch {
    /* no previous file */
  }
  await fs.rename(tmp, SETTINGS_FILE);
}

export async function loadSettings(): Promise<Settings> {
  if (cache) return cache;
  await ensureDataDir();
  try {
    const raw = await fs.readFile(SETTINGS_FILE, 'utf8');
    const parsed = SettingsSchema.parse(JSON.parse(raw));
    // Backfill secrets that may be empty in older files.
    if (!parsed.auth.jwtSecret) parsed.auth.jwtSecret = randomBytes(48).toString('hex');
    cache = parsed;
  } catch {
    cache = defaults();
    await persist(cache);
  }
  return cache;
}

export async function getSettings(): Promise<Settings> {
  return cache ?? (await loadSettings());
}

/** Mutate settings via an updater fn, validate, persist, and refresh cache. */
export async function updateSettings(
  mutator: (draft: Settings) => void | Promise<void>,
): Promise<Settings> {
  const current = await getSettings();
  const draft: Settings = JSON.parse(JSON.stringify(current));
  await mutator(draft);
  const validated = SettingsSchema.parse(draft);
  cache = validated;
  await persist(validated);
  return validated;
}

/** Redact secrets for sending to the client. */
export function redactSettings(s: Settings) {
  return {
    ...s,
    auth: { hasPassword: Boolean(s.auth.passwordHash) },
    git: { ...s.git, token: s.git.token ? '••••••••' : '' },
    api: {
      ...s.api,
      keys: s.api.keys.map((k) => ({
        id: k.id,
        name: k.name,
        prefix: k.prefix,
        scopes: k.scopes,
        createdAt: k.createdAt,
        lastUsed: k.lastUsed,
      })),
    },
  };
}
