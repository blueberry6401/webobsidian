/**
 * Tải file ZIP từ URL về đĩa, có guard SSRF (FR-16, `upload_from_url`).
 *
 * Dùng `http`/`https` thô chứ không dùng `fetch` toàn cục: chỉ ở đây mới truyền
 * được `lookup` tuỳ biến, tức là kiểm địa chỉ NGAY TẠI THỜI ĐIỂM CONNECT trên
 * đúng IP sẽ được kết nối. Kiểm trước bằng `dns.resolve` rồi mới `fetch` sẽ hở
 * cửa DNS rebinding (bản ghi đổi giữa hai lần tra).
 */
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { createWriteStream, promises as fs } from 'node:fs';

export const MAX_FETCH_BYTES = 500 * 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
/** Magic bytes mở đầu mọi file ZIP hợp lệ: "PK\x03\x04". */
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

/**
 * Lối thoát CHỈ DÙNG CHO TEST: e2e dựng hai server trên 127.0.0.1 nên nếu không
 * có nó thì luồng chính (vault A → vault B) không tài nào kiểm chứng cục bộ
 * được. Đọc env tại thời điểm gọi chứ không lúc nạp module, để test bật/tắt
 * được. TUYỆT ĐỐI không bật trên production: nó mở đường cho người cầm MCP key
 * đọc mọi service chỉ bind 127.0.0.1 trên máy chủ.
 */
function allowLoopback(): boolean {
  return process.env.WEBOBSIDIAN_FETCH_ALLOW_LOOPBACK === '1';
}

/**
 * Guard SSRF. Chặn loopback + link-local (gồm `169.254.169.254` — endpoint
 * metadata của cloud provider).
 *
 * KHÔNG chặn dải LAN riêng (10/8, 172.16/12, 192.168/16): hai vault self-hosted
 * rất có thể cùng mạng nội bộ, chặn là hỏng đúng use case chính. Người gọi đã
 * phải cầm MCP key hợp lệ nên đây không phải endpoint mở.
 */
export function isBlockedAddress(ip: string): boolean {
  const addr = ip.toLowerCase().replace(/^::ffff:/, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 127) return !allowLoopback(); // loopback
    if (a === 0) return true; // "this host"
    if (a === 169 && b === 254) return true; // link-local + metadata cloud
    return false;
  }
  if (addr === '::1') return !allowLoopback();
  if (addr === '::') return true;
  // fe80::/10 — link-local IPv6
  if (/^fe[89ab]/.test(addr)) return true;
  return false;
}

type LookupCb = (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number,
) => void;

/** `dns.lookup` có kiểm IP — chạy tại thời điểm connect nên chống DNS rebinding. */
const guardedLookup = ((hostname: string, options: unknown, cb?: LookupCb): void => {
  const callback = (typeof options === 'function' ? options : cb) as LookupCb;
  const opts = (typeof options === 'function' ? {} : options) as dns.LookupOneOptions;
  dns.lookup(hostname, opts, (err, address, family) => {
    if (err) return callback(err, address, family);
    const list = Array.isArray(address)
      ? (address as dns.LookupAddress[])
      : [{ address: address as string, family: family ?? 4 }];
    for (const a of list) {
      if (isBlockedAddress(a.address)) {
        return callback(
          Object.assign(new Error(`Địa chỉ bị chặn: ${a.address}`), { code: 'EBLOCKED' }),
          '',
          4,
        );
      }
    }
    callback(null, address, family);
  });
}) as unknown as typeof dns.lookup;

/**
 * Tải ZIP từ `url` về `destPath`. Xác thực là ZIP bằng magic bytes chứ KHÔNG tin
 * `Content-Type`. Theo tối đa 3 redirect, kiểm IP lại ở từng hop.
 */
export async function fetchZipToFile(url: string, destPath: string): Promise<{ bytes: number }> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Chỉ hỗ trợ http/https, nhận được ${u.protocol}`);
    }
    // Node BỎ QUA `lookup` khi hostname đã là địa chỉ IP dạng số — nên chỉ dựa
    // vào guardedLookup thôi là hở: `http://169.254.169.254/` (dạng luôn được
    // dùng để gọi metadata cloud) sẽ đi thẳng qua. Phải kiểm IP literal ở đây.
    const literal = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literal) && isBlockedAddress(literal)) {
      throw new Error(`Địa chỉ bị chặn: ${literal}`);
    }
    const mod = u.protocol === 'https:' ? https : http;
    const res = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = mod.get(u, { lookup: guardedLookup }, resolve);
      req.setTimeout(CONNECT_TIMEOUT_MS, () => req.destroy(new Error('Hết thời gian kết nối')));
      req.on('error', reject);
    });

    if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
      res.resume(); // xả body để giải phóng socket
      current = new URL(res.headers.location, u).toString();
      continue;
    }
    if (res.statusCode !== 200) {
      res.resume();
      throw new Error(`Tải thất bại: HTTP ${res.statusCode}`);
    }

    const out = createWriteStream(destPath);
    let bytes = 0;
    let magicOk: boolean | null = null;
    let head: Buffer = Buffer.alloc(0);
    try {
      await new Promise<void>((resolve, reject) => {
        out.on('error', reject);
        res.on('error', reject);
        res.on('data', (chunk: Buffer) => {
          if (magicOk === null) {
            head = Buffer.concat([head, chunk]);
            if (head.length >= 4) {
              magicOk = head.subarray(0, 4).equals(ZIP_MAGIC);
              if (!magicOk) {
                res.destroy();
                reject(new Error('Nội dung tải về không phải file zip'));
                return;
              }
            }
          }
          bytes += chunk.length;
          if (bytes > MAX_FETCH_BYTES) {
            res.destroy();
            reject(new Error(`File vượt giới hạn ${MAX_FETCH_BYTES} byte`));
            return;
          }
          if (!out.write(chunk)) {
            res.pause();
            out.once('drain', () => res.resume());
          }
        });
        res.on('end', () => out.end(() => resolve()));
      });
    } catch (e) {
      out.destroy();
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw e;
    }
    if (magicOk !== true) {
      await fs.rm(destPath, { force: true }).catch(() => {});
      throw new Error('Nội dung tải về không phải file zip');
    }
    return { bytes };
  }
  throw new Error(`Vượt quá ${MAX_REDIRECTS} redirect`);
}
