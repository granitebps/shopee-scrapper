import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSearchTools } from './tools/search.js';
import { registerProductTools } from './tools/product.js';
import { registerVariantTools } from './tools/variants.js';
import { registerStatusTools } from './tools/status.js';
import { registerReviewTools } from './tools/reviews.js';
import { registerShopTools } from './tools/shop.js';
import { registerFlashSaleTools } from './tools/flashsale.js';
import { registerCartTools } from './tools/cart.js';
import { registerAccountTools } from './tools/account.js';
import { registerActionTools } from './tools/actions.js';
import { initAccountMode } from './account-mode.js';

// Read the version from package.json at runtime so it can't drift from the
// published package version (this file previously hardcoded a stale string).
const __dirname = dirname(fileURLToPath(import.meta.url));
export const VERSION = (
  JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf-8')) as { version: string }
).version;

/**
 * Build a server with every tool registered. Shared by the stdio and HTTP
 * transports so the tool set can't drift between them. Call `release` once the
 * server is closed so account mode stops tracking its tools.
 */
export function createServer(): { server: McpServer; release: () => void } {
  const server = new McpServer({
    name: 'shopee-mcp',
    version: VERSION,
  });

  // Register tool groups. Every tool runs through the shared, logged-in browser
  // session (see src/browser/session.ts) — sign in once with `npm run login`.
  registerSearchTools(server);
  registerProductTools(server);
  registerVariantTools(server);
  registerReviewTools(server);
  registerShopTools(server);
  registerFlashSaleTools(server);
  registerStatusTools(server);
  // Experimental account tools (reads of the user's own data, and the only
  // tools that modify the account). Registered hidden; account mode shows them
  // once the session is confirmed logged in (see src/account-mode.ts).
  const release = initAccountMode(server);
  registerAccountTools(server);
  registerCartTools(server);
  registerActionTools(server);

  return { server, release };
}
