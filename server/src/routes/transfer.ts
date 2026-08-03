/**
 * Truyền file hàng loạt qua HTTP, NGOÀI luồng MCP (FR-16) — bytes không bao giờ
 * đi qua context của model.
 *
 * Không auth: token 256-bit nằm trong URL, cùng mô hình với `/share`.
 *
 * ⚠️ `/transfer` PHẢI nằm trong danh sách loại trừ của SPA catch-all
 * (`app.get('*')` trong index.ts), nếu không mọi đường dẫn ở đây trả về 200 HTML
 * của SPA — cùng loại bẫy đã ghi ở `docs/MCP.md` cho `/.well-known/*`.
 */
import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { promises as fs, createReadStream } from 'node:fs';
import { asyncHandler } from '../middleware/error.js';
import { createSlidingWindowCounter } from '../lib/slidingwindow.js';
import { extractZip, type ExtractResult } from '../services/archive.js';
import {
  getTicket,
  claimUploadTicket,
  finishUploadTicket,
  failUploadTicket,
  transferDir,
} from '../services/transfer.js';
import { escapeHtml } from '../services/renderhtml.js';
import { qmd } from '../services/search.js';
import { buildLinkGraph } from '../services/links.js';
import { broadcast } from '../services/realtime.js';
import { MAX_FETCH_BYTES } from '../services/fetchzip.js';

export const transferRouter = Router();

const rateOk = createSlidingWindowCounter(60_000);
const RATE_LIMIT_PER_MIN = 60;
transferRouter.use((req, res, next) => {
  if (!rateOk(req.ip ?? 'unknown', RATE_LIMIT_PER_MIN)) {
    res.status(429).json({ error: 'rate_limited' });
    return;
  }
  next();
});

/**
 * Sau khi giải nén: cập nhật index tìm kiếm cho từng note, nhưng dựng lại đồ thị
 * liên kết MỘT LẦN cho cả mẻ (không phải mỗi file một lần — với 500 file thì đó
 * là 500 lần quét toàn vault).
 */
export function reindexAfterExtract(written: string[]): void {
  for (const rel of written) {
    if (rel.toLowerCase().endsWith('.md')) void qmd.upsert(rel).catch(() => {});
  }
  void buildLinkGraph().catch(() => {});
  broadcast({ type: 'tree-changed' });
}

transferRouter.get(
  '/d/:token',
  asyncHandler(async (req: Request, res: Response) => {
    const t = getTicket(req.params.token);
    if (!t || t.kind !== 'download') {
      res.status(404).json({ error: 'ticket_not_found_or_expired' });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(t.filename)}`,
    );
    res.setHeader('Content-Length', String(t.bytes));
    const stream = createReadStream(t.zipPath);
    stream.on('error', () => {
      if (!res.headersSent) res.status(410).json({ error: 'zip_gone' });
      else res.end();
    });
    stream.pipe(res);
  }),
);

/** Trang kéo-thả. Script inline dùng CSP nonce của request, giống trang share SSR. */
function uploadPage(nonce: string, body: string, interactive: boolean): string {
  const script = interactive
    ? `<script nonce="${nonce}">
const drop=document.getElementById('drop'),inp=document.getElementById('f'),out=document.getElementById('out');
const esc=s=>s.replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
drop.onclick=()=>inp.click();
drop.ondragover=e=>{e.preventDefault();drop.classList.add('over')};
drop.ondragleave=()=>drop.classList.remove('over');
drop.ondrop=e=>{e.preventDefault();drop.classList.remove('over');if(e.dataTransfer.files[0])send(e.dataTransfer.files[0])};
inp.onchange=()=>{if(inp.files[0])send(inp.files[0])};
async function send(file){
  out.textContent='Đang tải lên '+file.name+'…';
  const fd=new FormData();fd.append('file',file);
  try{
    const r=await fetch(location.pathname,{method:'POST',body:fd});
    const j=await r.json();
    if(!r.ok){out.textContent='Lỗi: '+(j.error||r.status);return}
    drop.style.display='none';
    out.innerHTML='<p><b>Đã ghi '+j.written.length+' file.</b>'+
      (j.skipped.length?' Bỏ qua '+j.skipped.length+'.':'')+
      (j.errors.length?' Lỗi '+j.errors.length+'.':'')+'</p><ul>'+
      j.written.map(p=>'<li><code>'+esc(p)+'</code></li>').join('')+'</ul>';
  }catch(e){out.textContent='Lỗi: '+e.message}
}
</script>`
    : '';
  return `<!doctype html><html lang="vi"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Tải file lên vault</title>
<style nonce="${nonce}">
body{font-family:system-ui,-apple-system,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;line-height:1.6;color:#111}
#drop{border:2px dashed #999;border-radius:.5rem;padding:3rem 1rem;text-align:center;cursor:pointer}
#drop.over{border-color:#3b82f6;background:#eff6ff}
ul{max-height:20rem;overflow:auto}code{word-break:break-all}
@media(prefers-color-scheme:dark){body{background:#111;color:#eee}#drop.over{background:#1e3a5f}}
</style></head><body>${body}${script}</body></html>`;
}

transferRouter.get(
  '/u/:token',
  asyncHandler(async (req: Request, res: Response) => {
    const nonce = String(res.locals.cspNonce ?? '');
    const t = getTicket(req.params.token);
    if (!t || t.kind !== 'upload') {
      res
        .status(404)
        .type('html')
        .send(uploadPage(nonce, '<h1>Link không tồn tại hoặc đã hết hạn</h1>', false));
      return;
    }
    if (t.claimed && t.status !== 'error') {
      res.type('html').send(uploadPage(nonce, '<h1>Link này đã được dùng rồi</h1>', false));
      return;
    }
    const dest = t.destFolder ? escapeHtml(t.destFolder) : '(gốc vault)';
    res.type('html').send(
      uploadPage(
        nonce,
        `<h1>Tải file zip lên vault</h1>
     <p>Đích: <code>${dest}</code> — trùng tên thì <code>${escapeHtml(t.onConflict)}</code>.</p>
     <div id="drop">Kéo file <b>.zip</b> vào đây, hoặc bấm để chọn</div>
     <input id="f" type="file" accept=".zip,application/zip" hidden>
     <div id="out"></div>`,
        true,
      ),
    );
  }),
);

// diskStorage chứ KHÔNG phải memoryStorage (khác /api/files/upload): file zip có
// thể tới 500 MB, nạp cả vào RAM là mở đường DoS.
const uploadZip = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      void transferDir().then(
        (d) => cb(null, d),
        (e: Error) => cb(e, ''),
      );
    },
    filename: (_req, _file, cb) => cb(null, `up-${Date.now()}-${Math.round(Math.random() * 1e9)}.zip`),
  }),
  limits: { fileSize: MAX_FETCH_BYTES, files: 1 },
});

transferRouter.post(
  '/u/:token',
  uploadZip.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const cleanup = async (): Promise<void> => {
      if (req.file) await fs.rm(req.file.path, { force: true }).catch(() => {});
    };
    const t = claimUploadTicket(req.params.token);
    if (!t) {
      await cleanup();
      res.status(404).json({ error: 'ticket_not_found_expired_or_used' });
      return;
    }
    if (!req.file) {
      failUploadTicket(t.id, 'thiếu file');
      res.status(400).json({ error: 'file required' });
      return;
    }
    let result: ExtractResult;
    try {
      result = await extractZip(req.file.path, t.destFolder, t.onConflict);
    } catch (e) {
      await cleanup();
      failUploadTicket(t.id, (e as Error).message);
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    await cleanup();
    finishUploadTicket(t.id, result);
    reindexAfterExtract(result.written);
    res.json(result);
  }),
);
