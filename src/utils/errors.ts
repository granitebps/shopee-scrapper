import { ShopeeAPIError, ShopeeAuthRequiredError } from '../api/client.js';
import { setLoggedIn } from '../account-mode.js';

type TextResult = { content: Array<{ type: 'text'; text: string }> };

/**
 * Wraps a tool handler to return a clean MCP error content block, flagged
 * `isError` so clients can tell it from a result, instead of throwing and
 * crashing the server.
 */
export async function withErrorHandling<T extends TextResult>(
  fn: () => Promise<T>,
): Promise<T | (TextResult & { isError: true })> {
  try {
    return await fn();
  } catch (err) {
    let message: string;

    if (err instanceof ShopeeAuthRequiredError) {
      // The session is gone: fall back to read-only mode until it's back.
      setLoggedIn(false);
      message =
        '🔒 Not signed in to Shopee.\n\n' +
        'Shopee blocks anonymous product requests. Run this once in the project folder:\n' +
        '`npm run login`\n\n' +
        'A Chromium window opens — log into your Shopee account, then come back and press Enter. ' +
        'The session is saved and reused; retry your request afterwards.';
    } else if (err instanceof ShopeeAPIError) {
      message = `❌ Shopee API Error: ${err.message}`;
      if (err.statusCode === 429) {
        message += '\n\n💡 Tip: Rate limited by Shopee. Please wait a moment before retrying.';
      } else if (err.statusCode && err.statusCode >= 500) {
        message += '\n\n💡 Tip: Shopee is having a temporary issue. Please retry shortly.';
      }
    } else if (err instanceof Error) {
      message = `❌ Error: ${err.message}`;
    } else {
      message = `❌ Unknown error occurred`;
    }

    return { content: [{ type: 'text', text: message }], isError: true };
  }
}

/** Truncate text to max chars. */
export function truncate(text: string, maxLen = 200): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trimEnd() + '…';
}
