import { launchPersistentContext } from 'cloakbrowser';
import 'dotenv/config';
import os from 'node:os';
import path from 'node:path';
import type { BrowserContext, Page, Response } from 'playwright';
import { createIdleCloser, idleMsFrom } from './idle.js';

// ─── Configuration ────────────────────────────────────────────────────────────

export const DOMAIN = process.env.SHOPEE_DOMAIN || 'shopee.co.id';
export const BASE_URL = `https://${DOMAIN}`;

// Shopee tailors its web app to the visitor's region, so the browser's locale and
// timezone must match the domain we're browsing — a Malaysian store opened with an
// id-ID/Asia/Jakarta browser is an inconsistency the anti-bot gate can notice.
// Keyed by domain suffix; `SHOPEE_LOCALE` / `SHOPEE_TIMEZONE` override either one.
// `currency` is here because Shopee's newer search cards omit any per-item
// currency field (the old `item_basic.currency`), so the region is the only
// thing left to infer it from.
export interface Region {
  locale: string;
  timezone: string;
  currency: string;
}

const REGION_DEFAULTS: Record<string, Region> = {
  '.id': { locale: 'id-ID', timezone: 'Asia/Jakarta', currency: 'IDR' },
  '.my': { locale: 'en-MY', timezone: 'Asia/Kuala_Lumpur', currency: 'MYR' },
  '.sg': { locale: 'en-SG', timezone: 'Asia/Singapore', currency: 'SGD' },
  '.tw': { locale: 'zh-TW', timezone: 'Asia/Taipei', currency: 'TWD' },
};

// Falls back to the Indonesian defaults, matching the default SHOPEE_DOMAIN.
const FALLBACK_REGION = REGION_DEFAULTS['.id'];

/** Region defaults for a Shopee domain, chosen by its TLD suffix. */
export function regionFor(domain: string): Region {
  const suffix = Object.keys(REGION_DEFAULTS).find((s) => domain.endsWith(s));
  return suffix ? REGION_DEFAULTS[suffix] : FALLBACK_REGION;
}

const region = regionFor(DOMAIN);
export const LOCALE = process.env.SHOPEE_LOCALE || region.locale;
export const TIMEZONE = process.env.SHOPEE_TIMEZONE || region.timezone;
export const CURRENCY = region.currency;

export const PROFILE_DIR =
  process.env.SHOPEE_PROFILE_DIR || path.join(os.homedir(), '.shopee-mcp', 'chrome-profile');

// Shopee detects headless even with fingerprint patches, so we run HEADED by
// default (needs a display: WSLg, a desktop X server, or xvfb for servers).
// Set SHOPEE_HEADLESS=true only to experiment.
const HEADLESS = process.env.SHOPEE_HEADLESS === 'true';

// CloakBrowser picks a random fingerprint seed per launch unless one is given,
// so every restart would look like a new device to Shopee. A fixed seed keeps
// one coherent identity across launches (the login and the server alike).
const FINGERPRINT_SEED = process.env.SHOPEE_FINGERPRINT_SEED?.trim();

// Close the browser after this long without a tool call (0 keeps it open).
const BROWSER_IDLE_MS = idleMsFrom(process.env.SHOPEE_BROWSER_IDLE_MS);

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// Verbose logging is opt-in: only an explicit "true" enables it, so an unset,
// empty or malformed DEBUG leaves it off. Resolved once, and exported so every
// caller shares one definition of "is debugging on" rather than re-reading env.
export const DEBUG = process.env.DEBUG === 'true';

function debug(msg: string): void {
  if (DEBUG) process.stderr.write(`[shopee-mcp] ${msg}\n`);
}

// ─── Context singleton ────────────────────────────────────────────────────────
//
// Shopee gates product data behind per-request anti-fraud signatures that only
// its own SDK, running in a non-detected browser, can mint. So we drive
// CloakBrowser (a fingerprint-patched Chromium) against a persistent profile the
// user logs into once (npm run login). We never hand-craft the signed request —
// instead we navigate to the relevant page and intercept the response Shopee's
// app fires (see captureJson).

let contextPromise: Promise<BrowserContext> | null = null;
// Set while a browser is shutting down, so a relaunch waits for it to release
// the profile instead of colliding with it.
let closing: Promise<void> | null = null;

async function createContext(headless: boolean): Promise<BrowserContext> {
  debug(
    `Launching CloakBrowser (headless=${headless}, locale=${LOCALE}, tz=${TIMEZONE}) ` +
      `with profile: ${PROFILE_DIR}`,
  );
  const ctx = (await launchPersistentContext({
    userDataDir: PROFILE_DIR,
    headless,
    userAgent: USER_AGENT,
    locale: LOCALE,
    timezone: TIMEZONE,
    viewport: { width: 1366, height: 768 },
    humanize: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      ...(FINGERPRINT_SEED ? [`--fingerprint=${FINGERPRINT_SEED}`] : []),
    ],
  })) as unknown as BrowserContext;
  return ctx;
}

/**
 * Get the shared browser context, launching it on first use.
 * `headless` overrides the env default (the login flow forces a visible window).
 */
export async function getContext(headless: boolean = HEADLESS): Promise<BrowserContext> {
  if (!contextPromise && closing) await closing;
  if (!contextPromise) {
    const launching = createContext(headless);
    contextPromise = launching;
    // A long-running server must survive a browser crash or failed launch: drop
    // the dead context so the next call relaunches instead of failing forever.
    launching.then(
      (ctx) =>
        ctx.on('close', () => {
          if (contextPromise === launching) contextPromise = null;
        }),
      () => {
        if (contextPromise === launching) contextPromise = null;
      },
    );
  }
  return contextPromise;
}

/** Whether a browser is launched (or launching) — reported by the HTTP /health. */
export function browserStarted(): boolean {
  return contextPromise !== null;
}

/** The single reused page. */
async function getPage(): Promise<Page> {
  const ctx = await getContext();
  const existing = ctx.pages().find((p) => !p.isClosed());
  return existing ?? (await ctx.newPage());
}

// ─── Serialized navigation + interception ──────────────────────────────────────
//
// A single page is shared across tool calls; serialize access so overlapping
// calls don't clobber each other's navigation.

let lock: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = lock.then(fn, fn);
  lock = run.catch(() => {});
  return run;
}

// The idle close takes the same lock, so it can never cut into a navigation.
const idle = createIdleCloser(
  BROWSER_IDLE_MS,
  () =>
    serialize(async () => {
      if (idle.busy()) return;
      debug(`Browser idle for ${BROWSER_IDLE_MS}ms; closing it`);
      await closeContext();
    }),
  browserStarted,
);

/** Tool-facing lock: serialized, and counted as activity for the idle close. */
function withLock<T>(fn: () => Promise<T>): Promise<T> {
  return idle.track(() => serialize(fn));
}

/**
 * Keep the browser open until closeContext, whatever SHOPEE_BROWSER_IDLE_MS
 * says. The login flows call this so the window can't close mid-sign-in.
 */
export function keepBrowserOpen(): void {
  idle.disable();
}

export interface CaptureOptions {
  /** Substring the target /api/v4 response URL must contain. */
  apiMatch: string;
  /** Max time to wait for the matching response (ms). */
  timeoutMs?: number;
}

/**
 * Navigate to `pageUrl` and return the JSON body of the first `/api/v4/*`
 * response whose URL contains `apiMatch` — i.e. the request Shopee's own app
 * fires (carrying the valid anti-fraud signature). Returns the raw parsed JSON;
 * callers inspect its `error` field.
 */
export async function captureJson<T>(pageUrl: string, opts: CaptureOptions): Promise<T> {
  // 60s, not 30s: Shopee's search page only fires its `search_items` request at
  // ~28-30s, so a 30s budget lost the race often enough to trigger the retry in
  // shopeeCapture — turning a healthy-but-slow page into a 60s+ round trip.
  const timeoutMs = opts.timeoutMs ?? 60000;
  return withLock(async () => {
    const page = await getPage();

    // The body is read inside the predicate so an unreadable match is skipped
    // rather than fatal: a page that redirects (e.g. /<username> → shop page)
    // fires the call twice, and the first body is gone once it navigates away.
    let json: T | undefined;
    const matched = page.waitForResponse(
      async (r: Response) => {
        if (!/\/api\/v\d+\//.test(r.url()) || !r.url().includes(opts.apiMatch)) return false;
        try {
          json = (await r.json()) as T;
          return true;
        } catch {
          debug(`Unreadable ${opts.apiMatch} response; waiting for the next one`);
          return false;
        }
      },
      { timeout: timeoutMs },
    );

    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

    await matched;
    return json as T;
  });
}

export interface SelectionOptions<P> {
  /** Substring identifying the page's main /api/v4 response. */
  apiMatch: string;
  /** Substring identifying the response each selection fires. */
  selectionApiMatch: string;
  /** Labels to click, derived from the main response. */
  labelsFrom: (primary: P) => string[];
  /** Cap on how many selections to click; the rest are left ungathered. */
  maxSelections?: number;
  /**
   * Wall-clock budget for the whole call. Selections stop once it's spent, so a
   * slow network or a long option list can't push the tool past the ~60s request
   * timeout most MCP clients default to. Partial results beat a dead request.
   */
  deadlineMs?: number;
  timeoutMs?: number;
}

/**
 * Like captureJson, but afterwards clicks a set of on-page options and captures
 * the response each one fires — for data Shopee reveals only on interaction
 * (per-variant stock lives in cart_panel/select_variation_pc, never in get_pc).
 *
 * One navigation serves both halves. Clicks go through a plain DOM `click()`
 * rather than Playwright's: CloakBrowser's humanised pointer path first scrolls
 * the element into view, which throws on Shopee's virtualised variant list.
 */
export async function captureWithSelections<P, S>(
  pageUrl: string,
  opts: SelectionOptions<P>,
): Promise<{ primary: P; selections: Map<string, S> }> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  const deadline = Date.now() + (opts.deadlineMs ?? 50000);
  return withLock(async () => {
    const page = await getPage();

    const matched = page.waitForResponse(
      (r: Response) => r.url().includes('/api/v4/') && r.url().includes(opts.apiMatch),
      { timeout: timeoutMs },
    );
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const primary = (await (await matched).json()) as P;

    const selections = new Map<string, S>();
    const labels = opts.labelsFrom(primary).slice(0, opts.maxSelections ?? 12);
    if (labels.length === 0) return { primary, selections };

    // The payload lands before React paints the options; wait for one to exist.
    await page
      .waitForFunction(
        (ls: string[]) =>
          ls.some((l) =>
            Array.from(document.querySelectorAll('button')).some(
              (b) => (b.textContent || '').trim() === l,
            ),
          ),
        labels,
        { timeout: 30000 },
      )
      .catch(() => debug('Variant options never rendered; skipping selections'));

    for (const label of labels) {
      // Each selection is a full round trip, so check the budget before starting
      // another rather than discovering mid-flight that we've overrun.
      const remaining = deadline - Date.now();
      if (remaining < 6000) {
        debug(`Selection budget spent; ${selections.size}/${labels.length} gathered`);
        break;
      }

      const fired = page
        .waitForResponse((r: Response) => r.url().includes(opts.selectionApiMatch), {
          timeout: Math.min(12000, remaining),
        })
        .catch(() => null);

      const clicked = await page.evaluate((l: string) => {
        const b = Array.from(document.querySelectorAll('button')).find(
          (x) => (x.textContent || '').trim() === l,
        );
        if (!b) return false;
        b.click();
        return true;
      }, label);

      if (!clicked) {
        debug(`No option button for "${label}"`);
        continue;
      }
      const resp = await fired;
      if (!resp) {
        debug(`No ${opts.selectionApiMatch} response for "${label}"`);
        continue;
      }
      try {
        selections.set(label, (await resp.json()) as S);
      } catch {
        debug(`Unparsable ${opts.selectionApiMatch} response for "${label}"`);
      }
    }

    return { primary, selections };
  });
}

/**
 * Run a browser operation against the shared logged-in page, holding the same
 * lock as captureJson so it can't interleave with another tool's navigation.
 */
export async function withPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  return withLock(async () => fn(await getPage()));
}

/** One JSON response gathered by captureAll. */
export interface CollectedResponse {
  url: string;
  /** The request body, for telling apart calls to one endpoint (e.g. cart/update actions). */
  postData: string;
  json: unknown;
}

export interface CollectOptions {
  /** A response is collected when its URL contains any of these substrings. */
  apiMatches: string[];
  /**
   * Drives the page after navigation (scrolling, clicking filters, paging) while
   * responses keep being collected. `collected` fills in live, so the callback
   * can wait on it with waitForCollected.
   */
  interact?: (page: Page, collected: CollectedResponse[]) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Navigate to `pageUrl` and collect every matching API response fired while the
 * page loads and `interact` runs — for data Shopee only fetches on scroll or
 * click (reviews, flash-sale batches), which a single captureJson can't reach.
 *
 * Matches any `/api/vN/` path, not just v4: reviews still live on /api/v2.
 */
export async function captureAll(
  pageUrl: string,
  opts: CollectOptions,
): Promise<CollectedResponse[]> {
  const timeoutMs = opts.timeoutMs ?? 60000;
  return withLock(async () => {
    const page = await getPage();
    const collected: CollectedResponse[] = [];
    const pending: Promise<void>[] = [];

    const onResponse = (r: Response): void => {
      const url = r.url();
      if (!/\/api\/v\d+\//.test(url) || !opts.apiMatches.some((m) => url.includes(m))) return;
      const postData = r.request().postData() ?? '';
      pending.push(
        r
          .json()
          .then((json: unknown) => {
            collected.push({ url, postData, json });
          })
          .catch(() => debug(`Unparsable response from ${url}`)),
      );
    };

    page.on('response', onResponse);
    try {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      if (opts.interact) await opts.interact(page, collected);
      await Promise.all(pending);
    } finally {
      page.off('response', onResponse);
    }
    return collected;
  });
}

/**
 * Poll until `collected` satisfies `done`, or the timeout passes. Resolves to
 * whether it was satisfied; `tick` runs between polls (e.g. to keep scrolling).
 */
export async function waitForCollected(
  collected: CollectedResponse[],
  done: (c: CollectedResponse[]) => boolean,
  timeoutMs: number,
  tick?: () => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (done(collected)) return true;
    if (tick) await tick();
    await new Promise((r) => setTimeout(r, 500));
  }
  return done(collected);
}

/** Warm the session once (loads Shopee so the anti-fraud SDK initialises). */
export async function warm(): Promise<void> {
  await withLock(async () => {
    const page = await getPage();
    if (!page.url().includes(DOMAIN)) {
      debug('Warming session on Shopee homepage…');
      await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
    }
  });
}

/** Best-effort check that the saved profile is logged in. */
export async function isLoggedIn(): Promise<boolean> {
  // Not under the navigation lock (reading cookies doesn't navigate), but still
  // activity: check_login_status alone can launch the browser.
  return idle.track(async () => {
    const ctx = await getContext();
    const cookies = await ctx.cookies(BASE_URL);
    // Shopee sets SPC_U (user id) only once sign-in completes, and it persists
    // across restarts. SPC_EC can appear mid-sign-in and is a session cookie,
    // so it would report a login the saved profile does not have.
    return cookies.some((c) => c.name === 'SPC_U' && c.value.length > 4);
  });
}

/** Cleanly close the browser (used on shutdown, after login and when idle). */
export async function closeContext(): Promise<void> {
  idle.cancel();
  const pending = contextPromise;
  if (!pending) return closing ?? undefined;
  // Detach first so a concurrent getContext waits on `closing` rather than
  // being handed the browser that is going away.
  contextPromise = null;
  const done = pending
    .then((ctx) => ctx.close())
    .catch(() => {})
    .finally(() => {
      if (closing === done) closing = null;
    });
  closing = done;
  await done;
}
