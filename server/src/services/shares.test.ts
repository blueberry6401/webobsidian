import { describe, it, expect } from 'vitest';
import { isExpired, withinShareFolder, normalizeShareRecord } from './shares.js';

describe('isExpired', () => {
  it('returns false when expiresAt is unset', () => {
    expect(isExpired(undefined)).toBe(false);
    expect(isExpired(null)).toBe(false);
  });

  it('returns false when expiresAt is in the future', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(isExpired(future)).toBe(false);
  });

  it('returns true when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    expect(isExpired(past)).toBe(true);
  });

  it('accepts an explicit now for deterministic tests', () => {
    const now = new Date('2026-01-02T00:00:00.000Z').getTime();
    expect(isExpired('2026-01-01T00:00:00.000Z', now)).toBe(true);
    expect(isExpired('2026-01-03T00:00:00.000Z', now)).toBe(false);
  });
});

describe('withinShareFolder', () => {
  it('matches the shared folder itself', () => {
    expect(withinShareFolder('Folder', 'Folder')).toBe(true);
  });

  it('matches a file nested inside the shared folder', () => {
    expect(withinShareFolder('Folder', 'Folder/Sub/note.md')).toBe(true);
  });

  it('rejects a sibling folder whose name merely starts with the same prefix', () => {
    expect(withinShareFolder('Folder', 'Folder2/note.md')).toBe(false);
  });

  it('rejects an unrelated path', () => {
    expect(withinShareFolder('Folder', 'Other/note.md')).toBe(false);
  });
});

describe('normalizeShareRecord', () => {
  it('defaults kind to file for records written before the field existed', () => {
    const rec = normalizeShareRecord({ id: 'a', path: 'Note.md', enabled: true, createdAt: '2026-01-01' });
    expect(rec?.kind).toBe('file');
  });

  it('preserves an explicit folder kind', () => {
    const rec = normalizeShareRecord({ id: 'a', path: 'Folder', kind: 'folder', enabled: true, createdAt: '2026-01-01' });
    expect(rec?.kind).toBe('folder');
  });

  it('rejects entries missing required fields', () => {
    expect(normalizeShareRecord({ id: 'a' })).toBeNull();
    expect(normalizeShareRecord(null)).toBeNull();
  });
});
