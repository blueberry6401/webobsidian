import { loadSettings as _load, getSettings } from './services/settings.js';
import { setPassword } from './services/auth.js';
import { config } from './config.js';

export { getSettings };

export async function loadSettings() {
  return _load();
}

/** If WEBOBSIDIAN_PASSWORD is set and no password exists yet, seed it. */
export async function setPasswordIfInitial(): Promise<void> {
  if (!config.initialPassword) return;
  const s = await getSettings();
  if (s.auth.passwordHash) return;
  await setPassword(config.initialPassword);
  console.log('[boot] initial password set from WEBOBSIDIAN_PASSWORD');
}
