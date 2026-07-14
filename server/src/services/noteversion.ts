import { createHash } from 'node:crypto';

/**
 * Phiên bản nội dung note dùng cho khóa lạc quan (optimistic lock) của Agent API.
 * Tất định theo bytes UTF-8 của nội dung — không phụ thuộc mtime (git/autosync làm
 * lệch mtime). Cắt 16 ký tự hex đầu: đủ chống va chạm cho quy mô một vault cá nhân,
 * gọn khi truyền qua header text cho model.
 */
export function contentVersion(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}
