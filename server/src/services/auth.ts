import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { getSettings, updateSettings } from './settings.js';

const scryptAsync = promisify(scrypt);
const KEYLEN = 64;

/** scrypt$<saltHex>$<hashHex> */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const derived = (await scryptAsync(password, salt, KEYLEN)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export async function isPasswordSet(): Promise<boolean> {
  const s = await getSettings();
  return Boolean(s.auth.passwordHash);
}

export async function setPassword(password: string): Promise<void> {
  if (password.length < 6) throw new Error('Password must be at least 6 characters');
  const hash = await hashPassword(password);
  await updateSettings((d) => {
    d.auth.passwordHash = hash;
  });
}

export async function checkPassword(password: string): Promise<boolean> {
  const s = await getSettings();
  if (!s.auth.passwordHash) return false;
  return verifyPassword(password, s.auth.passwordHash);
}

const TOKEN_TTL = '30d';

export async function issueToken(): Promise<string> {
  const s = await getSettings();
  return jwt.sign({ sub: 'owner' }, s.auth.jwtSecret, { expiresIn: TOKEN_TTL });
}

export async function verifyToken(token: string): Promise<boolean> {
  try {
    const s = await getSettings();
    jwt.verify(token, s.auth.jwtSecret);
    return true;
  } catch {
    return false;
  }
}

/** ---- API keys ----------------------------------------------------------- */

export function hashApiKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Returns { raw, record-fields }. `raw` is shown to the user exactly once. */
export function generateApiKey(): { raw: string; hash: string; prefix: string } {
  const raw = `wok_${randomBytes(24).toString('base64url')}`;
  return { raw, hash: hashApiKey(raw), prefix: raw.slice(0, 12) };
}
