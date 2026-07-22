import { Router, type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpServer } from '../services/mcptools.js';
import { authenticateKey } from '../services/mcpkeys.js';

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

mcpRouter.all('/', async (req: Request, res: Response) => {
  const record = await authenticateKey(extractKey(req));
  if (!record) {
    res
      .status(401)
      .json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null });
    return;
  }
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});
