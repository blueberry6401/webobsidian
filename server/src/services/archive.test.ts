import { describe, it, expect } from 'vitest';
import { safeEntryPath, pickTarget } from './archive.js';

describe('safeEntryPath', () => {
  it('giữ nguyên đường dẫn hợp lệ', () => {
    expect(safeEntryPath('Notes/Ideas.md')).toBe('Notes/Ideas.md');
  });

  it('chuẩn hoá dấu gạch ngược của zip tạo trên Windows', () => {
    expect(safeEntryPath('Notes\\Sub\\a.md')).toBe('Notes/Sub/a.md');
  });

  it('từ chối đường dẫn leo ra ngoài', () => {
    expect(safeEntryPath('../../etc/passwd')).toBeNull();
    expect(safeEntryPath('Notes/../../etc/passwd')).toBeNull();
    expect(safeEntryPath('Notes\\..\\..\\etc\\passwd')).toBeNull();
  });

  it('từ chối đường dẫn tuyệt đối (POSIX và Windows)', () => {
    expect(safeEntryPath('/etc/passwd')).toBeNull();
    expect(safeEntryPath('C:/Windows/system32')).toBeNull();
    expect(safeEntryPath('\\\\server\\share\\a.md')).toBeNull();
  });

  it('từ chối byte NUL', () => {
    expect(safeEntryPath('a\0b.md')).toBeNull();
  });

  it('từ chối ghi vào .trash và .git (không phân biệt hoa thường)', () => {
    expect(safeEntryPath('.trash/a.md')).toBeNull();
    expect(safeEntryPath('.git/hooks/post-merge')).toBeNull();
    expect(safeEntryPath('.GIT/hooks/post-merge')).toBeNull();
    expect(safeEntryPath('Notes/.git/config')).toBeNull();
  });

  it('từ chối entry rỗng hoặc chỉ có dấu chấm', () => {
    expect(safeEntryPath('')).toBeNull();
    expect(safeEntryPath('.')).toBeNull();
    expect(safeEntryPath('./')).toBeNull();
  });

  it('bỏ tiền tố ./ mà vẫn giữ phần còn lại', () => {
    expect(safeEntryPath('./Notes/a.md')).toBe('Notes/a.md');
  });

  it('giữ được tên có dấu tiếng Việt', () => {
    expect(safeEntryPath('Thư mục/Ghi chú.md')).toBe('Thư mục/Ghi chú.md');
  });
});

describe('pickTarget', () => {
  const has =
    (...taken: string[]) =>
    async (p: string): Promise<boolean> =>
      taken.includes(p);

  it('dùng đúng tên gốc khi chưa trùng', async () => {
    expect(await pickTarget('Notes/a.md', 'rename', has())).toEqual({ target: 'Notes/a.md' });
  });

  it('rename: thêm hậu tố tăng dần, giữ đuôi mở rộng', async () => {
    expect(await pickTarget('Notes/a.md', 'rename', has('Notes/a.md'))).toEqual({
      target: 'Notes/a (1).md',
    });
    expect(await pickTarget('Notes/a.md', 'rename', has('Notes/a.md', 'Notes/a (1).md'))).toEqual({
      target: 'Notes/a (2).md',
    });
  });

  it('rename: file ở gốc vault, không có thư mục cha', async () => {
    expect(await pickTarget('a.md', 'rename', has('a.md'))).toEqual({ target: 'a (1).md' });
  });

  it('rename: file không có đuôi mở rộng', async () => {
    expect(await pickTarget('LICENSE', 'rename', has('LICENSE'))).toEqual({ target: 'LICENSE (1)' });
  });

  it('rename: dotfile không bị cắt nhầm phần đuôi', async () => {
    expect(await pickTarget('.env', 'rename', has('.env'))).toEqual({ target: '.env (1)' });
  });

  it('overwrite: giữ nguyên tên', async () => {
    expect(await pickTarget('Notes/a.md', 'overwrite', has('Notes/a.md'))).toEqual({
      target: 'Notes/a.md',
    });
  });

  it('skip: báo bỏ qua', async () => {
    expect(await pickTarget('Notes/a.md', 'skip', has('Notes/a.md'))).toEqual({ skip: true });
  });
});
