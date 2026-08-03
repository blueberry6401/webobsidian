import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isBlockedAddress, fetchZipToFile, MAX_FETCH_BYTES } from './fetchzip.js';
import { buildRawZip } from './rawzip.js';

describe('isBlockedAddress', () => {
  it('chặn loopback', () => {
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('127.9.9.9')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
  });

  it('chặn link-local, gồm cả endpoint metadata của cloud', () => {
    expect(isBlockedAddress('169.254.169.254')).toBe(true);
    expect(isBlockedAddress('169.254.0.1')).toBe(true);
    expect(isBlockedAddress('fe80::1')).toBe(true);
    expect(isBlockedAddress('feb0::1')).toBe(true);
  });

  it('chặn 0.0.0.0, :: và địa chỉ IPv4-mapped của loopback', () => {
    expect(isBlockedAddress('0.0.0.0')).toBe(true);
    expect(isBlockedAddress('::')).toBe(true);
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true);
  });

  it('CHO PHÉP dải LAN riêng — hai vault self-hosted thường cùng mạng nội bộ', () => {
    expect(isBlockedAddress('192.168.1.10')).toBe(false);
    expect(isBlockedAddress('10.0.0.5')).toBe(false);
    expect(isBlockedAddress('172.16.0.1')).toBe(false);
  });

  it('cho phép IP public', () => {
    expect(isBlockedAddress('1.1.1.1')).toBe(false);
    expect(isBlockedAddress('2606:4700::1111')).toBe(false);
  });

  it('lối thoát WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK chỉ mở loopback, không mở link-local', () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    try {
      expect(isBlockedAddress('127.0.0.1')).toBe(false);
      expect(isBlockedAddress('::1')).toBe(false);
      expect(isBlockedAddress('169.254.169.254')).toBe(true); // vẫn chặn
      expect(isBlockedAddress('0.0.0.0')).toBe(true);
    } finally {
      delete process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK;
    }
  });
});

describe('fetchZipToFile', () => {
  let server: http.Server;
  let base: string;
  let workDir: string;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    workDir = mkdtempSync(path.join(tmpdir(), 'wo-fetch-'));
    server = http.createServer((req, res) => handler(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(workDir, { recursive: true, force: true });
    delete process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK;
  });

  const dest = (): string => path.join(workDir, 'out.zip');

  it('CHẶN loopback ở đường chạy thật khi chưa bật lối thoát', async () => {
    handler = (_req, res) => res.end(buildRawZip([{ name: 'a.md', content: 'x' }]));
    await expect(fetchZipToFile(`${base}/a.zip`, dest())).rejects.toThrow(/bị chặn|EBLOCKED/);
    expect(existsSync(dest())).toBe(false);
  });

  it('tải được zip hợp lệ khi lối thoát bật', async () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    const zip = buildRawZip([{ name: 'a.md', content: 'nội dung' }]);
    handler = (_req, res) => res.end(zip);
    const { bytes } = await fetchZipToFile(`${base}/a.zip`, dest());
    expect(bytes).toBe(zip.length);
    expect(readFileSync(dest()).equals(zip)).toBe(true);
  });

  it('từ chối nội dung không phải zip dù Content-Type nói là zip', async () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    handler = (_req, res) => {
      res.setHeader('Content-Type', 'application/zip');
      res.end('<html>đây không phải zip</html>');
    };
    await expect(fetchZipToFile(`${base}/a.zip`, dest())).rejects.toThrow(/không phải file zip/);
    expect(existsSync(dest())).toBe(false);
  });

  it('từ chối HTTP khác 200', async () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    handler = (_req, res) => {
      res.statusCode = 404;
      res.end('không thấy');
    };
    await expect(fetchZipToFile(`${base}/a.zip`, dest())).rejects.toThrow(/HTTP 404/);
  });

  it('chặn IP literal của metadata cloud — Node bỏ qua lookup cho hostname dạng số', async () => {
    // Regression: chỉ cài guard vào dns.lookup là hở, vì Node không tra DNS khi
    // hostname đã là IP. Endpoint metadata luôn được gọi bằng IP literal.
    await expect(fetchZipToFile('http://169.254.169.254/latest/meta-data/', dest())).rejects.toThrow(
      /bị chặn/,
    );
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    await expect(fetchZipToFile('http://169.254.169.254/latest/meta-data/', dest())).rejects.toThrow(
      /bị chặn/,
    );
  });

  it('chặn IPv6 literal trong ngoặc vuông', async () => {
    await expect(fetchZipToFile('http://[::1]:80/a.zip', dest())).rejects.toThrow(/bị chặn/);
  });

  it('từ chối scheme không phải http/https', async () => {
    await expect(fetchZipToFile('file:///etc/passwd', dest())).rejects.toThrow(/http\/https/);
  });

  it('theo redirect và vẫn kiểm IP ở hop mới', async () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    const zip = buildRawZip([{ name: 'b.md', content: 'sau redirect' }]);
    handler = (req, res) => {
      if (req.url === '/start') {
        res.statusCode = 302;
        res.setHeader('Location', '/real.zip');
        res.end();
        return;
      }
      res.end(zip);
    };
    const { bytes } = await fetchZipToFile(`${base}/start`, dest());
    expect(bytes).toBe(zip.length);
  });

  it('dừng khi vượt quá số redirect cho phép', async () => {
    process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK = '1';
    handler = (_req, res) => {
      res.statusCode = 302;
      res.setHeader('Location', '/again');
      res.end();
    };
    await expect(fetchZipToFile(`${base}/start`, dest())).rejects.toThrow(/redirect/);
  });

  it('MAX_FETCH_BYTES là 500 MB', () => {
    expect(MAX_FETCH_BYTES).toBe(500 * 1024 * 1024);
  });
});
