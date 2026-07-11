import { describe, it, expect } from 'vitest';
import { Text } from '@codemirror/state';
import { outline } from './markdown';
import { scanDocHeadings } from './livePreview';

const SRC = [
  '# Trip',
  '',
  'Intro',
  '',
  '## Ngày 1',
  '',
  '```bash',
  '# not a heading',
  '## also not',
  '```',
  '',
  '## Ngày 2',
  '### Sáng',
].join('\n');

describe('outline() skips fenced code', () => {
  it('không tính dòng # trong ``` như heading', () => {
    expect(outline(SRC).map((h) => h.text)).toEqual([
      'Trip', 'Ngày 1', 'Ngày 2', 'Sáng',
    ]);
  });

  it('khớp scanDocHeadings về {level,text}', () => {
    const a = outline(SRC).map((h) => ({ level: h.level, text: h.text }));
    const b = scanDocHeadings(Text.of(SRC.split('\n'))).map((h) => ({ level: h.level, text: h.text }));
    expect(a).toEqual(b);
  });
});
