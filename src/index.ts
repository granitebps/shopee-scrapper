#!/usr/bin/env node
import 'dotenv/config';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { accountToolsSetting, refreshAccountMode } from './account-mode.js';
import { closeContext, DEBUG } from './browser/session.js';
import { createServer } from './server.js';
import { startHttpServer } from './http.js';

// stdio (default) for local MCP clients; MCP_TRANSPORT=http serves Streamable
// HTTP for a long-running service (see src/http.ts).
const TRANSPORT = (process.env.MCP_TRANSPORT || 'stdio').trim().toLowerCase();

async function main() {
  if (TRANSPORT === 'http') {
    await startHttpServer();
  } else if (TRANSPORT === 'stdio') {
    const { server } = createServer();
    await server.connect(new StdioServerTransport());
    if (DEBUG) {
      process.stderr.write('[shopee-mcp] Server started via stdio (browser-backed discovery)\n');
    }
  } else {
    throw new Error(`Unknown MCP_TRANSPORT "${TRANSPORT}" (expected "stdio" or "http")`);
  }

  // Check the session in the background so a logged-in user gets the account
  // tools without calling anything first; clients are notified via list_changed.
  if (accountToolsSetting() === 'auto') void refreshAccountMode();
}

// Tidy up the browser on shutdown.
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void closeContext().finally(() => process.exit(0));
  });
}

main().catch((err) => {
  process.stderr.write(`[shopee-mcp] Fatal error: ${err}\n`);
  process.exit(1);
});
