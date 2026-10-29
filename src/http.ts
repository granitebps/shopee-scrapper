/**
 * Streamable HTTP transport for running as a long-lived service (Docker).
 *
 *   POST /mcp     MCP over Streamable HTTP, stateless
 *   GET  /health  liveness; never launches the browser
 *
 * Stateless: every POST gets a fresh McpServer + transport (the SDK's
 * stateless pattern), so there are no sessions to expire or lose. That matters
 * here because the service is stopped for every Shopee re-login, and a
 * stateful client would otherwise hit "session not found" after each restart.
 * All servers share the one browser session, which serializes navigation.
 */
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { accountToolsSetting, accountModeActive } from './account-mode.js';
import { browserStarted, DEBUG, DOMAIN } from './browser/session.js';
import { createServer, VERSION } from './server.js';

const HOST = process.env.MCP_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.PORT || '8000', 10);

function log(msg: string): void {
  process.stderr.write(`[shopee-mcp] ${msg}\n`);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

function jsonRpcError(res: ServerResponse, status: number, code: number, message: string): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // Stateless mode has no standalone SSE stream (GET) or session to end (DELETE).
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    jsonRpcError(res, 405, -32000, 'Method not allowed.');
    return;
  }

  const { server, release } = createServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void server.close();
    release();
  });

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    log(`Error handling MCP request: ${err instanceof Error ? err.message : String(err)}`);
    if (!res.headersSent) jsonRpcError(res, 500, -32603, 'Internal server error');
  }
}

function handleHealth(res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    version: VERSION,
    domain: DOMAIN,
    browser: browserStarted() ? 'started' : 'idle',
    accountTools: accountToolsSetting() === 'off' ? 'off' : accountModeActive() ? 'on' : 'hidden',
  });
}

export async function startHttpServer(): Promise<void> {
  const httpServer = createHttpServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (DEBUG) log(`${req.method} ${path}`);
    if (path === '/mcp') {
      void handleMcp(req, res);
    } else if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleHealth(res);
    } else {
      sendJson(res, 404, { error: 'not found' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(PORT, HOST, () => resolve());
  });
  log(`Streamable HTTP listening on http://${HOST}:${PORT}/mcp`);
}
