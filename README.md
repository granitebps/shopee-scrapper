# shopee-mcp

[![npm](https://img.shields.io/npm/v/@bintangtimurlangit/shopee-mcp?style=flat-square)](https://www.npmjs.com/package/@bintangtimurlangit/shopee-mcp)
[![license](https://img.shields.io/github/license/bintangtimurlangit/shopee-mcp?style=flat-square)](./LICENSE)
[![CI](https://img.shields.io/github/actions/workflow/status/bintangtimurlangit/shopee-mcp/ci.yml?branch=main&style=flat-square)](https://github.com/bintangtimurlangit/shopee-mcp/actions)
[![GitHub Repo](https://img.shields.io/badge/GitHub-shopee--mcp-24292f?style=flat-square&logo=github)](https://github.com/bintangtimurlangit/shopee-mcp)

An MCP server for **exploring Shopee** — product search, prices, reviews, shops and flash sales — from any MCP client (Claude Desktop, Claude Code, etc.). Discovery only: no seller features.

> **Login required, read-only.** Shopee blocks anonymous requests, so this **unofficial** server reads public data through your own logged-in browser session (see [Why a browser?](#why-a-browser)). Signed out it is read-only; signed in it also offers [experimental account tools](#account-mode-experimental) for your orders, cart, vouchers, likes and follows.

**Full reference:** [Documentation](./docs/README.md) · **Changelog:** [CHANGELOG.md](./CHANGELOG.md) · **Versioning & releases:** [docs/RELEASES.md](./docs/RELEASES.md)

## Tools

| Tool                   | What it returns                                                                                                                                            |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search_products`      | Keyword search with sorting, **filters** (price range, min rating, seller location, Shopee Mall only) & pagination — prices, sold counts, IDs, URLs.       |
| `get_product_detail`   | One product — price & discount, rating, sold count, stock, category, **specs**, **shipping** (fee, free-shipping threshold, ETA), **seller**, description. |
| `get_product_variants` | Every variant of a listing — model IDs, variant names, per-variant prices and availability. Opt into `includeStock` for exact counts.                      |
| `get_product_reviews`  | Rating summary (star breakdown, with-media/comment counts) and pages of buyer reviews — filter by star rating, comments, or media.                         |
| `get_shop_info`        | A seller's profile by shop ID or username — badges, rating, products, followers, chat response rate/time, join date, last active.                          |
| `get_shop_products`    | One shop's catalogue, with sorting (popular, newest, top sales, price) & pagination.                                                                       |
| `get_flash_sale`       | The current Flash Sale — session window, upcoming sessions, and deals with flash vs. original price and how much stock is claimed.                         |
| `check_login_status`   | Whether the saved browser session is logged into Shopee — check this first instead of waiting on a slow failure.                                           |

### Tool annotations

Per the [MCP annotations spec](https://modelcontextprotocol.io/) — every default tool is read-only, with no side effects.

| Tool                   | Read-only | Idempotent | Destructive |
| ---------------------- | :-------: | :--------: | :---------: |
| `search_products`      |     ✓     |     ✓      |      –      |
| `get_product_detail`   |     ✓     |     ✓      |      –      |
| `get_product_variants` |     ✓     |     ✓      |      –      |
| `get_product_reviews`  |     ✓     |     ✓      |      –      |
| `get_shop_info`        |     ✓     |     ✓      |      –      |
| `get_shop_products`    |     ✓     |     ✓      |      –      |
| `get_flash_sale`       |     ✓     |     –      |      –      |
| `check_login_status`   |     ✓     |     ✓      |      –      |

## Account mode (experimental)

When the saved session is **logged in**, the server also offers tools that work on **your own account**. When it isn't, you get the read-only tools above and the account tools are hidden. The server checks the login in the background at startup and whenever `check_login_status` runs or a request reports a lapsed session, and tells your MCP client to refresh its tool list (`notifications/tools/list_changed`). Set `SHOPEE_ACCOUNT_TOOLS=off` to stay read-only even while logged in.

**Read your account**

| Tool                | What it returns                                                                                    |
| ------------------- | -------------------------------------------------------------------------------------------------- |
| `get_orders`        | Your orders by tab (all, to ship, to receive, completed, cancelled) — status, shop, items, totals. |
| `get_order_detail`  | One order — items, total paid, payment channel, timeline, courier, tracking number & events.       |
| `get_my_vouchers`   | Vouchers in your wallet — benefit, scope, minimum spend, expiry, code.                             |
| `get_coins`         | Shopee Coins balance and recent coin transactions.                                                 |
| `get_notifications` | Order updates, promotions, or Shopee updates.                                                      |
| `get_cart`          | Your cart grouped by shop — items, variants, quantities, prices, model IDs.                        |
| `get_shop_vouchers` | A shop's claimable vouchers, and which ones you've already claimed.                                |

**Act on your account** — these modify your Shopee account:

| Tool                 | What it does                                                                |
| -------------------- | --------------------------------------------------------------------------- |
| `add_to_cart`        | Adds a product — the exact variant via `modelId` — in a quantity of 1-20.   |
| `update_cart_item`   | Changes a cart line's quantity, or removes it with `quantity: 0`.           |
| `like_product`       | Likes or unlikes a product.                                                 |
| `follow_shop`        | Follows or unfollows a shop.                                                |
| `claim_shop_voucher` | Claims one of a shop's vouchers into your wallet (a claim can't be undone). |

How they stay safe:

- **Nothing checks out, pays, or touches addresses, payment methods, passwords, or chat.** Order detail omits your address and phone number.
- Every action clicks **Shopee's own button** on the real page (never a hand-crafted request), then reports only what Shopee's response confirmed.
- They check the current state first — liking a liked product, or claiming a claimed voucher, changes nothing.
- They refuse rather than guess: a multi-variant listing needs an explicit `modelId`, `add_to_cart` verifies the quantity box shows exactly what you asked for and never falls back to "Buy Now", and `claim_shop_voucher` only clicks when the page's voucher buttons line up with the shop's voucher list.

They drive Shopee's UI, so a site redesign can break them — hence _experimental_. The cart tools build on [@DystopiaOwO](https://github.com/DystopiaOwO)'s fork.

## Why a browser?

Shopee does **not** expose an open API or server-rendered product HTML. Its `/api/v4/*` endpoints are guarded by an anti-fraud gate (`error 90309999`) that requires per-request signature headers (`af-ac-enc-dat`, `x-sap-sec`, …) minted by Shopee's own obfuscated SDK. Plain `fetch`, headless Chromium, and even a hand-rolled fetch from inside the page all get rejected.

So this server:

1. Drives **[CloakBrowser](https://github.com/CloakHQ/cloakbrowser)** — a Chromium with binary-level fingerprint patches — against a **persistent profile you log into once**.
2. **Navigates to the real Shopee page and intercepts the response** its own app fetches, so the request carries valid signatures.

The browser must run **headed** (Shopee detects headless); on a server use a virtual display (`xvfb`).

### From npm (recommended)

```bash
npm install -g @bintangtimurlangit/shopee-mcp   # downloads the CloakBrowser binary (~200 MB, cached)
```

This puts two commands on your PATH: **`shopee-mcp`** (the server) and **`shopee-mcp-login`** (one-time login). Or run without installing: `npx -y @bintangtimurlangit/shopee-mcp`.

### From source

```bash
git clone https://github.com/bintangtimurlangit/shopee-mcp.git
cd shopee-mcp
npm install          # also downloads the CloakBrowser binary (~200 MB, cached)
npm run build
```

### 1. Log in once

Shopee blocks anonymous requests, so you sign in one time. This saves a session to `~/.shopee-mcp/chrome-profile`.

```bash
shopee-mcp-login     # global install — or, from a source checkout:  npm run login
```

- Opens a CloakBrowser window — log in, then press Enter.
- On a desktop / WSLg, the window appears normally.
- Re-run only when the session expires.

### 2. Register with your MCP client

The server launches a **headed** browser, so it needs a display. On a headless machine, wrap it with `xvfb-run`.

Claude Desktop / Claude Code `mcpServers` entry:

```json
{
  "mcpServers": {
    "shopee": {
      "command": "xvfb-run",
      "args": ["-a", "shopee-mcp"]
    }
  }
}
```

On a machine with a real display, drop `xvfb-run`: `"command": "shopee-mcp"`, `"args": []`. From a source checkout, use `"command": "node"`, `"args": ["/absolute/path/to/shopee-mcp/build/index.js"]` (wrapped in `xvfb-run` on a headless box).

## Configuration

All optional — see `.env.example`. Copy to `.env` to override.

| Variable               | Default                        | Purpose                                                         |
| ---------------------- | ------------------------------ | --------------------------------------------------------------- |
| `SHOPEE_DOMAIN`        | `shopee.co.id`                 | Regional Shopee domain (`.co.id`, `.com.my`, `.sg`, `.tw`).     |
| `SHOPEE_LOCALE`        | _derived from domain_          | Browser locale override.                                        |
| `SHOPEE_TIMEZONE`      | _derived from domain_          | Browser timezone override.                                      |
| `SHOPEE_PROFILE_DIR`   | `~/.shopee-mcp/chrome-profile` | Where the saved login lives.                                    |
| `SHOPEE_HEADLESS`      | `false`                        | Keep `false` — headless is detected.                            |
| `SHOPEE_ACCOUNT_TOOLS` | `auto`                         | `auto`: account tools while logged in. `off`: always read-only. |
| `CACHE_TTL_MS`         | `30000`                        | In-memory cache lifetime.                                       |
| `DEBUG`                | `false`                        | Log startup/debug info to stderr.                               |
| `MCP_TRANSPORT`        | `stdio`                        | `http` serves Streamable HTTP at `/mcp` (plus `GET /health`).   |

Tool timings and client timeouts: see [docs/CONFIGURATION.md](./docs/CONFIGURATION.md#tools-and-request-timeouts).

## Self-hosted Docker service

For running continuously on a Linux server (arm64 or amd64), this fork ships a two-container Compose deployment. `shopee-mcp` serves Streamable HTTP at `http://shopee-mcp:8000/mcp` on the external `ai-routing` network, read-only (`SHOPEE_ACCOUNT_TOOLS=off`). `shopee-login` is a temporary browser you drive over an SSH tunnel to sign in. Both use one persistent profile volume and never run at the same time.

```bash
docker compose up -d     # on the server
scripts/shopee-login     # from your laptop, to sign in or renew the session
```

Setup, configuration, shutdown and recovery: **[docs/DEPLOYMENT.md](./docs/DEPLOYMENT.md)**.

## Development

```bash
npm run lint         # eslint
npm run format       # prettier --write (format:check to verify)
npm run typecheck
npm run test:unit    # offline unit tests (no login/display needed)
npm test             # live smoke test (needs a display; use xvfb-run on servers)
npm run dev          # tsx watch
```

More detail: **[docs/DEVELOPMENT.md](./docs/DEVELOPMENT.md)**.

## Troubleshooting

| Symptom                                       | Likely cause / fix                                                                                                      |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `🔒 Not signed in` / anonymous-request errors | No/expired session → run `npm run login`.                                                                               |
| `error 90309999` or empty results             | Shopee's anti-bot gate rejected the request. Ensure you're logged in and running **headed** (or via `xvfb-run`); retry. |
| A read returns empty for a valid product      | Shopee lazy-loads; retry, and run with `DEBUG=true` to inspect.                                                         |
| Empty or stale results right after a change   | In-memory cache — lower `CACHE_TTL_MS` or wait for the TTL to expire.                                                   |
| Headless / server has no display              | Wrap the command in `xvfb-run -a …`.                                                                                    |

## Caveats

- **Login required.** Shopee blocks anonymous browsing: with no session, `get_shop_info` still works and every other tool returns a friendly "run `npm run login`" prompt.
- **Anti-bot is a moving target.** The free CloakBrowser binary can go stale as Shopee updates detection; CloakBrowser Pro ships newer patches.
- Respect Shopee's Terms of Service. This is for personal market exploration, not scraping at scale.
- **Regions.** Indonesia is the most tested; Malaysia, Singapore and Taiwan get the matching locale, timezone and currency automatically.

## Contributing & security

[CONTRIBUTING.md](./CONTRIBUTING.md) · [SECURITY.md](./SECURITY.md) · [Code of Conduct](./CODE_OF_CONDUCT.md)

## License

[MIT](./LICENSE)

---

## Disclaimer

This is an **unofficial** project. It is **not affiliated with, authorized, maintained, sponsored, or endorsed by Shopee or Sea Limited**.

It works by driving a real logged-in browser session against Shopee's web app, which can change without notice — a tool may break when Shopee updates its site or anti-bot behavior. Signed out it reads only public data; signed in, its experimental account tools read your own orders, cart, vouchers and notifications, and can change your cart, likes, follows and claimed vouchers — never checkout, payment, or account settings.

You are responsible for using this software in compliance with [Shopee's Terms of Service](https://shopee.co.id/docs/terms) and applicable law. Use reasonable request volumes. All product names, logos, and brands are property of their respective owners.
