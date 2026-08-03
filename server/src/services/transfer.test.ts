import { describe, it, expect, beforeEach } from 'vitest';
import {
  createDownloadTicket,
  createUploadTicket,
  getTicket,
  claimUploadTicket,
  finishUploadTicket,
  failUploadTicket,
  sweep,
  TTL_MS,
  __resetForTests,
} from './transfer.js';

const dl = (): ReturnType<typeof createDownloadTicket> =>
  createDownloadTicket({ zipPath: '/tmp/khong-ton-tai.zip', filename: 'a.zip', fileCount: 1, bytes: 10 });

beforeEach(() => __resetForTests());

describe('ticket tải', () => {
  it('sinh token base64url 43 ký tự (256 bit) và tra được', () => {
    const t = dl();
    expect(t.id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getTicket(t.id)?.kind).toBe('download');
  });

  it('hai ticket không trùng token', () => {
    expect(dl().id).not.toBe(dl().id);
  });

  it('dùng được nhiều lần trong TTL', () => {
    const t = dl();
    expect(getTicket(t.id)).not.toBeNull();
    expect(getTicket(t.id)).not.toBeNull();
    expect(getTicket(t.id, Date.now() + TTL_MS - 1000)).not.toBeNull();
  });

  it('hết hạn sau TTL', () => {
    const t = dl();
    expect(getTicket(t.id, Date.now() + TTL_MS + 1000)).toBeNull();
  });
});

describe('ticket đẩy', () => {
  it('chỉ claim được đúng một lần', () => {
    const t = createUploadTicket({ destFolder: 'Inbox', onConflict: 'rename' });
    expect(claimUploadTicket(t.id)).not.toBeNull();
    expect(claimUploadTicket(t.id)).toBeNull();
  });

  it('không claim được sau khi hết hạn', () => {
    const t = createUploadTicket({ destFolder: '', onConflict: 'rename' });
    expect(claimUploadTicket(t.id, Date.now() + TTL_MS + 1000)).toBeNull();
  });

  it('finish ghi kết quả để transfer_status đọc', () => {
    const t = createUploadTicket({ destFolder: '', onConflict: 'rename' });
    claimUploadTicket(t.id);
    finishUploadTicket(t.id, { written: ['a.md'], skipped: [], errors: [] });
    const got = getTicket(t.id);
    expect(got?.kind === 'upload' && got.status).toBe('done');
    expect(got?.kind === 'upload' && got.result?.written).toEqual(['a.md']);
  });

  it('thất bại thì mở lại ticket để thử lại — chưa có gì được ghi', () => {
    const t = createUploadTicket({ destFolder: '', onConflict: 'rename' });
    claimUploadTicket(t.id);
    failUploadTicket(t.id, 'không phải zip');
    const got = getTicket(t.id);
    expect(got?.kind === 'upload' && got.status).toBe('error');
    expect(claimUploadTicket(t.id)).not.toBeNull();
  });
});

describe('sweep', () => {
  it('xoá ticket đã hết hạn', () => {
    const t = dl();
    sweep(Date.now() + TTL_MS + 1000);
    expect(getTicket(t.id, Date.now())).toBeNull();
  });

  it('giữ nguyên ticket còn hạn', () => {
    const t = dl();
    sweep(Date.now());
    expect(getTicket(t.id)).not.toBeNull();
  });
});

describe('token không hợp lệ', () => {
  it('trả null thay vì ném lỗi', () => {
    expect(getTicket('khong-co-that')).toBeNull();
    expect(getTicket('')).toBeNull();
    expect(claimUploadTicket('khong-co-that')).toBeNull();
  });
});
