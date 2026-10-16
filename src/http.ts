import { timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import type { Env } from './llm.js';

export function mcpHandler(env: Env = process.env) {
  return async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const origin = req.headers.origin;
    const deploymentOrigins = [env.VERCEL_URL, env.VERCEL_PROJECT_PRODUCTION_URL].filter(Boolean).map(host => `https://${host}`);
    const localOrigins = env.VERCEL ? [] : [`http://127.0.0.1:${req.socket.localPort}`, `http://localhost:${req.socket.localPort}`];
    const allowed = [...deploymentOrigins, ...localOrigins, ...(env.MCP_ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)];
    if (origin && !allowed.includes(origin)) {
      res.status(403).json({ error: 'Origin not allowed' }); return;
    }
    if (env.MCP_AUTH_TOKEN) {
      const actual = Buffer.from(req.headers.authorization || '');
      const expected = Buffer.from(`Bearer ${env.MCP_AUTH_TOKEN}`);
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="seller-voice"');
        res.status(401).json({ error: 'Bearer token required' }); return;
      }
    }
    if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); res.status(405).json({ error: 'Use Streamable HTTP POST; standalone SSE and sessions are not used.' }); return; }
    const server = createServer(env);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Request failed' }, id: null }); }
  };
}
