# Configuration

For installing the package or cloning the repo, see **[Installation](../README.md#installation)** in the README.

> **Login required.** Shopee blocks anonymous requests, so this server reads public data through a saved browser session. Run `npm run login` once before use. There are no API keys — authentication is the browser session under `~/.shopee-mcp/chrome-profile`.

---

## Environment variables

All optional. Set them in your MCP client's **`env`** block, or copy `.env.example` to `.env` when developing from a checkout.

| Variable                  | Default                        | Description                                                                  |
| ------------------------- | ------------------------------ | ---------------------------------------------------------------------------- |
| `SHOPEE_DOMAIN`           | `shopee.co.id`                 | Regional Shopee domain.                                                      |
| `SHOPEE_LOCALE`           | _derived from domain_          | Browser locale override.                                                     |
| `SHOPEE_TIMEZONE`         | _derived from domain_          | Browser timezone override.                                                   |
| `SHOPEE_PROFILE_DIR`      | `~/.shopee-mcp/chrome-profile` | Where the saved login lives.                                                 |
| `SHOPEE_HEADLESS`         | `false`                        | Keep `false` — headless is detected.                                         |
| `SHOPEE_ACCOUNT_TOOLS`    | `auto`                         | `auto`: account tools while logged in; `off`: read-only.                     |
| `CACHE_TTL_MS`            | `30000`                        | In-memory cache lifetime.                                                    |
| `DEBUG`                   | `false`                        | Log startup/debug info to stderr.                                            |
| `MCP_TRANSPORT`           | `stdio`                        | `http`: stateless Streamable HTTP at `/mcp`, `GET /health`.                  |
| `MCP_HOST`                | `127.0.0.1`                    | HTTP bind address (`0.0.0.0` in the Docker image).                           |
| `PORT`                    | `8000`                         | HTTP port.                                                                   |
| `SHOPEE_FINGERPRINT_SEED` | _random per launch_            | Fixed browser fingerprint seed (the Docker image stores one in the profile). |

### Locale and timezone

Shopee tailors its web app to the visitor's region, so the browser's locale and timezone should match the domain being browsed. Both are derived from `SHOPEE_DOMAIN`'s TLD suffix:

| Domain suffix | Locale  | Timezone            | Currency |
| ------------- | ------- | ------------------- | -------- |
| `.id`         | `id-ID` | `Asia/Jakarta`      | `IDR`    |
| `.my`         | `en-MY` | `Asia/Kuala_Lumpur` | `MYR`    |
| `.sg`         | `en-SG` | `Asia/Singapore`    | `SGD`    |
| `.tw`         | `zh-TW` | `Asia/Taipei`       | `TWD`    |
| anything else | `id-ID` | `Asia/Jakarta`      | `IDR`    |

The currency is used to render prices when Shopee's response omits a per-item currency field, which the newer search card format does.

Set `SHOPEE_LOCALE` or `SHOPEE_TIMEZONE` to override either independently.

---

## Tools and request timeouts

The tool reference lives in the [root README](../README.md#tools). What matters for configuration is that **every call drives a real browser**, so responses take tens of seconds — far longer than a typical MCP tool. Most clients default to a **60-second** request timeout, and these calls sit close to it.

Measured on `shopee.co.id` (Sept 2026); Shopee serves each region differently — on `shopee.com.my` the search page was observed firing its request only ~28s into the load.

| Tool                                    | Typical | Notes                                                       |
| --------------------------------------- | ------- | ----------------------------------------------------------- |
| `check_login_status`                    | ~1-2s   | Cookie check; no navigation. Cheapest way to verify setup.  |
| `search_products`                       | ~5-30s  | One page load; slowest where Shopee delays the search call. |
| `get_product_detail`                    | ~4s     | One page load.                                              |
| `get_product_variants`                  | ~4s     | One page load.                                              |
| `get_product_variants` + `includeStock` | ~50s    | Adds a round trip per variant (see below).                  |
| `get_product_reviews`                   | ~6-12s  | Scrolls to the reviews, then one click per filter/page.     |
| `get_shop_info` / `get_shop_products`   | ~2-5s   | One page load.                                              |
| `get_flash_sale`                        | ~3-30s  | Scrolls until `limit` deals have loaded.                    |
| Account reads (`get_orders`, …)         | ~2-10s  | One page load; `get_orders` scrolls for more than 5 orders. |
| Account actions (`add_to_cart`, …)      | ~4-14s  | Page load, then clicks confirmed one response at a time.    |

`get_product_variants` reports exact per-variant stock only when `includeStock` is set, because Shopee reveals those counts one variant at a time — each costs a separate round trip. The lookup stops on a time budget so it stays inside a 60-second timeout, reporting availability for any variants it did not reach and stating the coverage in its output. Raising your client's timeout above ~70s lets it cover more variants per call; it is off by default so the common path stays fast.

A signed-out session returns the "run `npm run login`" prompt in about a second, so a slow call means work is happening, not that authentication is being retried.

---

## MCP configuration (all clients)

This server uses **stdio** and launches a **headed** browser, so it needs a display. On a headless machine, wrap the command in `xvfb-run`.

### With a virtual display (servers)

```json
{
  "mcpServers": {
    "shopee": {
      "command": "xvfb-run",
      "args": ["-a", "node", "/absolute/path/to/shopee-mcp/build/index.js"]
    }
  }
}
```

### With a real display (desktop / WSLg)

```json
{
  "mcpServers": {
    "shopee": {
      "command": "node",
      "args": ["/absolute/path/to/shopee-mcp/build/index.js"]
    }
  }
}
```

Use an **absolute** path to `build/index.js`.

---

## Claude Code

- **CLI:** `claude mcp add shopee -- xvfb-run -a node /absolute/path/to/shopee-mcp/build/index.js` (drop `xvfb-run -a` on a machine with a display).
- **Project scope:** `.mcp.json` in the repo root. **User scope:** `~/.claude.json`.
- **Restart** or reload so the new server is registered.

## Claude Desktop

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Linux:** `~/.config/Claude/claude_desktop_config.json`

Use the same **`mcpServers`** JSON as above.

## Hermes Agent

[Hermes Agent](https://github.com/NousResearch/hermes-agent) keeps MCP servers in **`~/.hermes/config.yaml`** under **`mcp_servers`** — note the snake_case key, unlike Claude's `mcpServers` — and manages them with `hermes mcp`.

```bash
hermes mcp add shopee --env SHOPEE_DOMAIN=shopee.com.my --command node --args /absolute/path/to/shopee-mcp/build/index.js
```

`--args` must come last: it consumes everything after it. On a headless machine use `--command xvfb-run --args -a node /absolute/path/to/shopee-mcp/build/index.js`.

The equivalent YAML, if you'd rather edit the file directly:

```yaml
mcp_servers:
  shopee:
    command: node
    args:
      - /absolute/path/to/shopee-mcp/build/index.js
    env:
      SHOPEE_DOMAIN: shopee.com.my
    enabled: true
```

**No timeout setting needed.** Hermes allows 300 seconds per tool call by default — comfortably above what this server needs (see [Tools and request timeouts](#tools-and-request-timeouts)). If you do want to pin it, the optional per-server `timeout` key is in **seconds**, not milliseconds: `timeout: 180` is three minutes.

Useful checks: `hermes mcp list` shows configured servers, and `hermes mcp test shopee` verifies the connection and tool discovery without starting a chat.

## Other editors

Cursor, Zed, Windsurf, and any other **stdio MCP host** use the same pattern: a server whose command is `node` (or `xvfb-run … node`) plus the path to `build/index.js`.
