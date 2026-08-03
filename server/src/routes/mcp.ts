import express, { Router, type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../services/mcptools.js';
import { authenticateKey } from '../services/mcpkeys.js';
import type { McpKeyRecord } from '../services/settings.js';
import { createSlidingWindowCounter } from '../lib/slidingwindow.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      mcpKey?: McpKeyRecord;
    }
  }
}

/**
 * MCP endpoint (Streamable HTTP, stateless). Auth: `?key=` token or Bearer,
 * verified against the MCP key store. A fresh server+transport is created per
 * request (stateless mode) — matches the retired Cloudflare Worker's model.
 */
export const mcpRouter = Router();

function extractKey(req: Request): string {
  const q = req.query.key;
  if (typeof q === 'string' && q) return q;
  const auth = req.headers.authorization;
  if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7);
  return '';
}

const mcpRateOk = createSlidingWindowCounter(60_000);
// No per-key setting for this (unlike api.rateLimitPerMin) — a fixed generous
// ceiling is enough to stop flood/DoS abuse without needing new config surface.
const MCP_RATE_LIMIT_PER_MIN = 120;

/**
 * Runs BEFORE the body is parsed: key auth only needs the query/header key, so
 * an unauthenticated (or already-throttled) caller is rejected before we ever
 * buffer their request body — closes a DoS where a large unauthenticated JSON
 * payload was read into memory only to be thrown away by a 401.
 */
async function mcpAuthGate(req: Request, res: Response, next: NextFunction): Promise<void> {
  const record = await authenticateKey(extractKey(req));
  if (!record) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  if (!mcpRateOk(record.id, MCP_RATE_LIMIT_PER_MIN)) {
    res.status(429).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Rate limit exceeded' }, id: null });
    return;
  }
  req.mcpKey = record;
  next();
}

mcpRouter.all('/', mcpAuthGate, express.json({ limit: '32mb' }), async (req: Request, res: Response) => {
  // Link do các tool transfer trả về phải tuyệt đối (người dùng bấm trong
  // claude.ai, hoặc vault khác fetch) — dựng từ chính request này.
  const server = createMcpServer(`${req.protocol}://${req.get('host')}`);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
