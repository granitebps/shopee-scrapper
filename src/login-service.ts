#!/usr/bin/env node
/**
 * Non-interactive login for a server with no desktop (the `shopee-login`
 * container). Unlike src/login.ts it never reads stdin:
 *
 *   1. opens a visible browser on the persistent profile at the login page
 *      (viewed remotely, e.g. over noVNC through an SSH tunnel);
 *   2. polls the session cookies and writes the state to SHOPEE_LOGIN_STATUS_FILE
 *      ("logged_in" / "logged_out") so an operator script can check it;
 *   3. on SIGTERM/SIGINT closes the browser cleanly so the profile is flushed
 *      to disk before the container stops.
 */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { getContext, isLoggedIn, closeContext, BASE_URL, PROFILE_DIR } from './browser/session.js';

const STATUS_FILE = process.env.SHOPEE_LOGIN_STATUS_FILE || '/tmp/shopee-login-status';
const POLL_MS = 3000;

function log(msg: string): void {
  process.stdout.write(`[shopee-login] ${msg}\n`);
}

let stopping = false;
async function stop(code: number): Promise<never> {
  stopping = true;
  log('Closing browser and saving the profile…');
  await closeContext().catch((err) => log(`Close failed: ${err}`));
  log('Profile saved.');
  process.exit(code);
}

async function main() {
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void stop(0));

  log(`Profile directory: ${PROFILE_DIR}`);
  writeFileSync(STATUS_FILE, 'starting\n');

  // Force a visible window regardless of SHOPEE_HEADLESS.
  const ctx = await getContext(false);
  ctx.on('close', () => {
    if (!stopping) {
      log('Browser closed unexpectedly.');
      process.exit(1);
    }
  });
  const page = ctx.pages().find((p) => !p.isClosed()) ?? (await ctx.newPage());
  await page.goto(`${BASE_URL}/buyer/login`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  log('Login page open. Complete the Shopee sign-in in the remote browser.');

  let last = '';
  for (;;) {
    const state = (await isLoggedIn().catch(() => false)) ? 'logged_in' : 'logged_out';
    if (state !== last) {
      writeFileSync(STATUS_FILE, `${state}\n`);
      log(`Session: ${state}`);
      last = state;
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch(async (err) => {
  log(`Login service failed: ${err}`);
  writeFileSync(STATUS_FILE, 'error\n');
  await closeContext().catch(() => {});
  process.exit(1);
});
