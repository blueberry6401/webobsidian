import { describe, it, expect } from 'vitest';
import { parseQuery, qmd } from './search.js';

describe('parseQuery — cụm nháy kép', () => {
  it('query thường không có nháy → không có phrase, giữ nguyên từ rời', () => {
    expect(parseQuery('hello world')).toEqual({ phrases: [], filterText: 'hello world', fields: [] });
  });

  it('tách "..." thành một phrase nguyên văn', () => {
    expect(parseQuery('"hello world"')).toEqual({ phrases: ['hello world'], filterText: '', fields: [] });
  });

  it('phrase đứng chung với từ rời và qualifier', () => {
    expect(parseQuery('"hello world" foo tag:idea')).toEqual({
      phrases: ['hello world'],
      filterText: 'foo idea',
      fields: ['tags'],
    });
  });

  it('nhiều phrase trong cùng query', () => {
    expect(parseQuery('"a b" x "c d"')).toEqual({ phrases: ['a b', 'c d'], filterText: 'x', fields: [] });
  });

  it('nháy chưa đóng = phrase kéo đến hết chuỗi (ổn định khi đang gõ)', () => {
    expect(parseQuery('foo "hel')).toEqual({ phrases: ['hel'], filterText: 'foo', fields: [] });
  });

  it('phrase rỗng hoặc chỉ khoảng trắng bị bỏ qua', () => {
    expect(parseQuery('"" foo "  "')).toEqual({ phrases: [], filterText: 'foo', fields: [] });
  });

  it('qualifier cụt sát phrase (title:"a b") không bị coi là từ "title" để tìm', () => {
    expect(parseQuery('title:"hello world"')).toEqual({ phrases: ['hello world'], filterText: '', fields: [] });
  });

  it('khoảng trắng thừa trong phrase được cắt ở hai đầu, giữ nguyên bên trong', () => {
    expect(parseQuery('"  hello   world "')).toEqual({ phrases: ['hello   world'], filterText: '', fields: [] });
  });
});

describe('qmd.queryTerms — needle cho highlight', () => {
  it('từ rời → mỗi từ một needle, bỏ từ < 2 ký tự', () => {
    expect(qmd.queryTerms('hello a world')).toEqual(['hello', 'world']);
  });

  it('cụm nháy kép → MỘT needle nguyên cụm, đứng trước từ rời', () => {
    expect(qmd.queryTerms('"hello world" foo')).toEqual(['hello world', 'foo']);
  });

  it('qualifier bị bóc prefix như trước, cụm vẫn nguyên', () => {
    expect(qmd.queryTerms('tag:idea "x y"')).toEqual(['x y', 'idea']);
  });
});
