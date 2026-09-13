// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const keys = [
  { id: 'k1', name: 'a Dat', prefix: 'mcp_L-UPWFLk', createdAt: '2026-07-23T00:00:00Z', lastUsed: null, revoked: false, permission: 'write' },
  { id: 'k2', name: 'Huyen', prefix: 'mcp_gwfxLiBv', createdAt: '2026-07-23T00:00:00Z', lastUsed: null, revoked: true, permission: 'write' },
];
const api = {
  listMcpKeys: vi.fn(async () => ({ keys: keys.map((k) => ({ ...k })) })),
  createMcpKey: vi.fn(async (name: string, permission: string) => {
    keys.push({ id: 'k3', name, prefix: 'mcp_NEW', createdAt: '2026-09-13T00:00:00Z', lastUsed: null, revoked: false, permission });
    return { key: 'mcp_NEWRAWKEY', record: keys[keys.length - 1] };
  }),
  setMcpKeyPermission: vi.fn(async (id: string, permission: string) => {
    const k = keys.find((x) => x.id === id)!; k.permission = permission; return { ok: true };
  }),
  revokeMcpKey: vi.fn(async () => ({ ok: true })),
};
vi.mock('../lib/api', () => ({ api }));

// Settings.tsx kéo theo Icon + store; chỉ cần McpKeys.
const { McpKeys } = await import('./Settings');

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);
const qa = <T extends Element>(sel: string) => Array.from(host.querySelectorAll<T>(sel));

beforeEach(async () => {
  document.body.innerHTML = ''; host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(createElement(McpKeys)); });
  await flush();
});

describe('Settings → MCP keys', () => {
  it('key còn hiệu lực có dropdown quyền cạnh nút Thu hồi; key đã thu hồi chỉ hiện nhãn', () => {
    const rows = qa<HTMLDivElement>('.setting-row');
    expect(rows.length).toBe(2);
    const active = rows[0]; const revoked = rows[1];
    const sel = active.querySelector<HTMLSelectElement>('select')!;
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('write');
    expect(active.querySelector('button.btn.danger')?.textContent).toContain('Thu hồi');
    expect(sel.parentElement).toBe(active.querySelector('button.btn.danger')?.parentElement);
    expect(revoked.querySelector('select')).toBeNull();
    expect(revoked.textContent).toContain('Đọc & ghi');
    expect(revoked.textContent).toContain('(đã thu hồi)');
  });

  it('đổi dropdown → gọi PATCH với quyền mới, UI cập nhật ngay', async () => {
    const sel = q<HTMLSelectElement>('.setting-row select')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
      setter.call(sel, 'read');
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect(api.setMcpKeyPermission).toHaveBeenCalledWith('k1', 'read');
    expect(q<HTMLSelectElement>('.setting-row select')!.value).toBe('read');
  });

  it('nút Tạo key mở modal có tên + quyền; Tạo → gọi API với đúng quyền, đóng modal, hiện URL', async () => {
    expect(q('.modal-bg')).toBeNull();
    const btn = qa<HTMLButtonElement>('button.btn').find((b) => b.textContent === 'Tạo key')!;
    await act(async () => { btn.click(); });
    const modal = q<HTMLDivElement>('.modal-bg .modal')!;
    expect(modal).toBeTruthy();
    expect(modal.textContent).toContain('Tạo MCP key');
    const nameInput = modal.querySelector<HTMLInputElement>('input.text-input')!;
    const permSel = modal.querySelector<HTMLSelectElement>('select')!;
    expect(nameInput && permSel).toBeTruthy();
    expect(permSel.value).toBe('write'); // mặc định Đọc & ghi

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(nameInput, 'Routine X');
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(permSel, 'read');
      permSel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const create = Array.from(modal.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Tạo')!;
    await act(async () => { create.click(); });
    await flush();
    expect(api.createMcpKey).toHaveBeenCalledWith('Routine X', 'read');
    expect(q('.modal-bg')).toBeNull();
    expect(host.querySelector('pre')?.textContent).toContain('/mcp?key=mcp_NEWRAWKEY');
    const newRow = qa<HTMLDivElement>('.setting-row').find((r) => r.textContent?.includes('Routine X'))!;
    expect(newRow.querySelector<HTMLSelectElement>('select')!.value).toBe('read');
  });

  it('Hủy đóng modal, không gọi API', async () => {
    const before = api.createMcpKey.mock.calls.length;
    const btn = qa<HTMLButtonElement>('button.btn').find((b) => b.textContent === 'Tạo key')!;
    await act(async () => { btn.click(); });
    const cancel = Array.from(q('.modal-bg')!.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === 'Hủy')!;
    await act(async () => { cancel.click(); });
    expect(q('.modal-bg')).toBeNull();
    expect(api.createMcpKey.mock.calls.length).toBe(before);
  });
});
