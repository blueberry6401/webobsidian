export interface HeadingInfo {
  level: number;
  text: string;
}

export const STORAGE_KEY = 'webobsidian:heading-fold';

/**
 * Với mỗi heading, dựng khóa breadcrumb = text các tổ tiên (heading cấp lớn hơn
 * gần nhất, đệ quy lên) nối bằng ' > '. Nếu hai heading cho ra breadcrumb trùng
 * khít, thêm hậu tố '#n' theo thứ tự xuất hiện để phân biệt. Hậu tố được kế thừa
 * xuống con (stack lưu label đã định danh) nên nhánh con của heading trùng vẫn
 * có khóa duy nhất và ổn định.
 */
export function computeHeadingKeys(headings: HeadingInfo[]): string[] {
  const keys: string[] = [];
  const seen = new Map<string, number>();
  const stack: { level: number; label: string }[] = [];
  for (const hd of headings) {
    // Pop các mục cùng cấp hoặc cấp nhỏ hơn (level >=) khỏi stack tổ tiên.
    while (stack.length && stack[stack.length - 1].level >= hd.level) stack.pop();
    const baseCrumb = [...stack.map((s) => s.label), hd.text].join(' > ');
    const n = (seen.get(baseCrumb) ?? 0) + 1;
    seen.set(baseCrumb, n);
    const key = n === 1 ? baseCrumb : `${baseCrumb}#${n}`;
    keys.push(key);
    // Label của heading này (tiền tố cho con) = text + hậu tố nếu breadcrumb trùng.
    const label = n === 1 ? hd.text : `${hd.text}#${n}`;
    stack.push({ level: hd.level, label });
  }
  return keys;
}

function readAll(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

export function loadCollapsed(notePath: string): Set<string> {
  const all = readAll();
  return new Set(all[notePath] ?? []);
}

export function saveCollapsed(notePath: string, keys: Set<string>): void {
  try {
    const all = readAll();
    if (keys.size === 0) delete all[notePath];
    else all[notePath] = [...keys];
    if (Object.keys(all).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
  } catch {
    /* localStorage unavailable (private mode/quota) — fold works in-session only */
  }
}
