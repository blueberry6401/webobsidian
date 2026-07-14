import { describe, it, expect } from 'vitest';
import { flattenFiles } from './tree';
import type { TreeNode } from './api';

const fixture: TreeNode = {
  name: 'root',
  path: '',
  type: 'folder',
  children: [
    { name: 'Note A.md', path: 'Note A.md', type: 'file', mtime: 300, ctime: 100 },
    {
      name: 'Trips',
      path: 'Trips',
      type: 'folder',
      children: [
        { name: 'Note B.md', path: 'Trips/Note B.md', type: 'file', mtime: 200, ctime: 50 },
        {
          name: 'Nested',
          path: 'Trips/Nested',
          type: 'folder',
          children: [
            { name: 'Note C.md', path: 'Trips/Nested/Note C.md', type: 'file', mtime: 400, ctime: 10 },
          ],
        },
      ],
    },
  ],
};

describe('flattenFiles', () => {
  it('collects every file node across nested folders, skipping folders themselves', () => {
    const paths = flattenFiles(fixture).map((f) => f.path).sort();
    expect(paths).toEqual(['Note A.md', 'Trips/Nested/Note C.md', 'Trips/Note B.md'].sort());
  });
  it('carries mtime/ctime through unchanged', () => {
    const b = flattenFiles(fixture).find((f) => f.path === 'Trips/Note B.md');
    expect(b).toEqual({ path: 'Trips/Note B.md', name: 'Note B.md', mtime: 200, ctime: 50 });
  });
  it('defaults missing mtime/ctime to 0', () => {
    const noStat: TreeNode = { name: 'x.md', path: 'x.md', type: 'file' };
    const flat = flattenFiles({ name: 'root', path: '', type: 'folder', children: [noStat] });
    expect(flat).toEqual([{ path: 'x.md', name: 'x.md', mtime: 0, ctime: 0 }]);
  });
  it('returns an empty array for a null tree', () => {
    expect(flattenFiles(null)).toEqual([]);
  });
});
