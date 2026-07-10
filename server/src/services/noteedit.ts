/**
 * Find/replace nguyên tử cho Agent API (PRD 1.8, FR-6).
 *
 * Hàm thuần — không đụng filesystem — để route PATCH /api/v1/notes/{path} dùng và
 * script kiểm chứng test trực tiếp. Mọi so khớp/thay thế đều là LITERAL string:
 * tuyệt đối không đưa `find`/`replace` vào `new RegExp()` (ký tự regex đặc biệt)
 * hay `String.replace(string, ...)` (bẫy pattern `$&`, `$1`, `$$` trong replacement)
 * — dùng indexOf + split/join.
 */

export interface EditSuccess {
  /** Nội dung mới sau khi thay. */
  content: string;
  /** Số lần đã thay (1 nếu không replaceAll). */
  replaced: number;
}

export interface EditFailure {
  error: 'find_not_found' | 'find_ambiguous';
  /** Số lần xuất hiện — chỉ có mặt với find_ambiguous. */
  count?: number;
}

export type EditResult = EditSuccess | EditFailure;

/** Đếm số lần xuất hiện (không chồng lấn) của `find` trong `content`. `find` phải khác rỗng. */
function countOccurrences(content: string, find: string): number {
  return content.split(find).length - 1;
}

/**
 * Áp find/replace lên `content`. Tiền điều kiện (route đã validate): `find` là string
 * khác rỗng, `replace` là string (được phép rỗng).
 * - 0 khớp → `{error: 'find_not_found'}`
 * - ≥2 khớp mà không `replaceAll` → `{error: 'find_ambiguous', count}`
 * - hợp lệ → thay lần đầu tiên (hoặc tất cả nếu `replaceAll`), trả `{content, replaced}`
 */
export function applyEdit(content: string, find: string, replace: string, replaceAll: boolean): EditResult {
  const count = countOccurrences(content, find);
  if (count === 0) return { error: 'find_not_found' };
  if (count >= 2 && !replaceAll) return { error: 'find_ambiguous', count };
  if (replaceAll) {
    // split/join = replaceAll literal, miễn nhiễm cả regex chars trong find lẫn $-patterns trong replace
    return { content: content.split(find).join(replace), replaced: count };
  }
  const idx = content.indexOf(find);
  return { content: content.slice(0, idx) + replace + content.slice(idx + find.length), replaced: 1 };
}
