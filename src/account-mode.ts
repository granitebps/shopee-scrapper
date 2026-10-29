/**
 * Account mode: the experimental account tools (orders, vouchers, cart writes,
 * likes, follows, …) are only offered while the saved session is logged in.
 *
 *   - Logged in  → account tools enabled alongside the read-only tools.
 *   - Signed out → read-only mode; account tools are hidden from tools/list.
 *
 * Tools are registered once and toggled together; one
 * `notifications/tools/list_changed` then tells clients to refresh their list.
 * SHOPEE_ACCOUNT_TOOLS=off pins the server to read-only mode regardless.
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { isLoggedIn } from './browser/session.js';

export type AccountToolsSetting = 'auto' | 'off';

export function accountToolsSetting(
  raw: string | undefined = process.env.SHOPEE_ACCOUNT_TOOLS,
): AccountToolsSetting {
  const v = (raw ?? '').trim().toLowerCase();
  return v === 'off' || v === 'false' || v === '0' ? 'off' : 'auto';
}

// One group per server instance: stdio has one for the process lifetime, while
// the stateless HTTP transport builds a server per request (see src/http.ts).
interface ServerGroup {
  tools: RegisteredTool[];
  notify?: () => void;
}

const groups = new Set<ServerGroup>();
// Tools registered before any initAccountMode call (tests) land here.
let current: ServerGroup = { tools: [] };
groups.add(current);
let active = false;

/**
 * Bind the server so a mode change can notify clients (once, not per tool).
 * Account tools registered after this belong to it. Returns a release function
 * that stops tracking them once the server is closed.
 */
export function initAccountMode(server: McpServer): () => void {
  const group: ServerGroup = { tools: [], notify: () => server.sendToolListChanged() };
  groups.add(group);
  current = group;
  return () => {
    groups.delete(group);
  };
}

/** Track an account tool. It starts hidden until a login is confirmed. */
export function registerAccountTool(tool: RegisteredTool): void {
  // Set the flag directly rather than via disable(): that would send one
  // list_changed notification per tool.
  tool.enabled = active;
  current.tools.push(tool);
}

/** Whether account tools are currently offered. */
export function accountModeActive(): boolean {
  return active;
}

/**
 * Show or hide the account tools for a known login state. Cheap and idempotent:
 * only a real change toggles tools (and so notifies the client).
 */
export function setLoggedIn(loggedIn: boolean): void {
  const next = loggedIn && accountToolsSetting() === 'auto';
  if (next === active) return;
  active = next;
  for (const g of groups) {
    for (const t of g.tools) t.enabled = next;
    try {
      g.notify?.();
    } catch {
      // A server mid-shutdown can't be notified; its tools are already updated.
    }
  }
}

/** Check the session and update account mode. Never throws. */
export async function refreshAccountMode(
  check: () => Promise<boolean> = isLoggedIn,
): Promise<boolean> {
  try {
    setLoggedIn(await check());
  } catch {
    setLoggedIn(false);
  }
  return active;
}
