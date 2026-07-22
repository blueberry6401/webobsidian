import { randomUUID, randomBytes } from 'node:crypto';
import { getSettings, updateSettings, type McpKeyRecord } from './settings.js';
import { hashApiKey } from './auth.js';

/** MCP connection keys — the `?key=` token Claude uses to reach /mcp. Separate
 *  from the `wok_` /api/v1 API keys. Soft-revoke keeps history like the old /admin. */

export async function listKeys(): Promise<Omit<McpKeyRecord, 'hash'>[]> {
  const s = await getSettings();
  return s.mcp.keys.map(({ hash, ...rest }) => rest);
}

export async function createKey(
  name: string,
): Promise<{ raw: string; record: Omit<McpKeyRecord, 'hash'> }> {
  const raw = `mcp_${randomBytes(24).toString('base64url')}`;
  const record: McpKeyRecord = {
    id: randomUUID(),
    name: name || 'MCP connection',
    hash: hashApiKey(raw),
    prefix: raw.slice(0, 12),
    createdAt: new Date().toISOString(),
    lastUsed: null,
    revoked: false,
  };
  await updateSettings((d) => {
    d.mcp.keys.push(record);
  });
  const { hash: _omit, ...safe } = record;
  return { raw, record: safe };
}

export async function revokeKey(id: string): Promise<boolean> {
  let changed = false;
  await updateSettings((d) => {
    const k = d.mcp.keys.find((x) => x.id === id);
    if (k && !k.revoked) {
      k.revoked = true;
      changed = true;
    }
  });
  return changed;
}

/** Look up a raw key; returns the matching active record (and bumps lastUsed). */
export async function authenticateKey(raw: string): Promise<McpKeyRecord | null> {
  if (!raw) return null;
  const hash = hashApiKey(raw);
  const s = await getSettings();
  const match = s.mcp.keys.find((k) => k.hash === hash && !k.revoked);
  if (!match) return null;
  void updateSettings((d) => {
    const k = d.mcp.keys.find((x) => x.id === match.id);
    if (k) k.lastUsed = new Date().toISOString();
  }).catch(() => {});
  return match;
}
