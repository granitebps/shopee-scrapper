// ─── Idle close ───────────────────────────────────────────────────────────────
//
// The browser launches on the first tool call and is reused, which keeps calls
// fast but leaves a Chromium window (and the profile lock) held for as long as
// the server runs. Closing it after a quiet spell frees both; the next call
// relaunches it in about a second.

/** Default idle period before the browser is closed: 5 minutes. */
export const DEFAULT_IDLE_MS = 5 * 60 * 1000;

// setTimeout overflows above 2^31-1 ms (~24.8 days) and fires immediately.
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/**
 * Parse SHOPEE_BROWSER_IDLE_MS. Unset, empty or invalid falls back to the
 * default; `0` turns idle closing off.
 */
export function idleMsFrom(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return DEFAULT_IDLE_MS;
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_IDLE_MS;
  return Math.min(ms, MAX_TIMEOUT_MS);
}

export interface IdleCloser {
  /** Run `fn` as browser activity: the countdown waits until it settles. */
  track<T>(fn: () => Promise<T>): Promise<T>;
  /** Whether any tracked activity is in flight. */
  busy(): boolean;
  /** Never close on idle again (the login flows keep their window open). */
  disable(): void;
  /** Drop a pending countdown, e.g. because the browser was closed already. */
  cancel(): void;
}

/**
 * Calls `close` once `idleMs` passes with no tracked activity and `isOpen()`
 * reports a browser. `close` should re-check `busy()` under the navigation lock,
 * since a call can arrive between the timer firing and the close running.
 */
export function createIdleCloser(
  idleMs: number,
  close: () => Promise<void>,
  isOpen: () => boolean,
): IdleCloser {
  let active = 0;
  let disabled = idleMs <= 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const arm = (): void => {
    cancel();
    if (disabled || active > 0 || !isOpen()) return;
    timer = setTimeout(() => {
      timer = null;
      if (!disabled && active === 0) void close().catch(() => {});
    }, idleMs);
    // A pending idle close must never keep the process alive on its own.
    timer.unref();
  };

  return {
    async track<T>(fn: () => Promise<T>): Promise<T> {
      active++;
      cancel();
      try {
        return await fn();
      } finally {
        active--;
        arm();
      }
    },
    busy: () => active > 0,
    disable(): void {
      disabled = true;
      cancel();
    },
    cancel,
  };
}
