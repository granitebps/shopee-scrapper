# Deployment (Docker, self-hosted)

Run shopee-mcp as a long-lived service on a Linux server (built and measured on linux/arm64; linux/amd64 also builds) and re-authenticate it from your laptop. The deployment is read-only discovery: account tools are pinned off.

## Architecture

```
MCP clients (Fami/OpenClaw, …)            your laptop
        │ ai-routing network                    │ ssh -L 127.0.0.1:16080 → 127.0.0.1:6080
        ▼                                       ▼
┌─────────────────────────┐        ┌──────────────────────────────┐
│ shopee-mcp              │        │ shopee-login (profile: login) │
│ :8000/mcp, GET /health  │        │ noVNC viewer → x11vnc → Xvfb  │
│ Xvfb + CloakBrowser     │        │ Xvfb + CloakBrowser           │
└───────────┬─────────────┘        └──────────────┬───────────────┘
            └──────── volume shopee-profile:/data ┘
                (one browser at a time: flock on /data)
```

- **`shopee-mcp`**: stateless Streamable HTTP at `/mcp` and `GET /health`, with no published ports. Containers on the external `ai-routing` network reach it at **`http://shopee-mcp:8000/mcp`**. The browser starts lazily on the first tool call and is reused; navigation stays serialized on one tab. After 5 minutes without a call it closes again (`SHOPEE_BROWSER_IDLE_MS`), and the next call relaunches it in about a second.
- **`shopee-login`**: started only to sign in. It opens the persistent profile at Shopee's login page on a virtual display and serves a browser viewer on the host's `127.0.0.1:6080` only. Normally it is stopped and uses no CPU or RAM.
- **Shared profile.** Both services mount the named volume `shopee-profile` at `/data`, and the profile lives in `/data/shopee-profile`. It survives restarts, rebuilds, container recreation and reboots.
- **Mutual exclusion.** The login service sits behind the Compose profile `login`, so a plain `docker compose up -d` never starts it. On top of that, both entrypoints take an exclusive `flock` on `/data/.shopee-profile.lock`, and a second container exits with code 75 rather than open the profile while another holds it. The kernel releases the lock when the holder's processes exit, so a crashed container never leaves a stale lock behind.
- **One identity.** The entrypoint creates a fingerprint seed once (`/data/shopee-profile/.shopee-mcp-seed`), so the login browser and the server present the same device to Shopee.

## Images

One multi-stage `Dockerfile`. Both targets derive from `browser-runtime-base`, so Docker stores the heavy layers once:

| Image                | Size (arm64, uncompressed) | Contents                                                                                                                     |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `shopee-mcp:local`   | 1.16 GB                    | Debian trixie-slim, Node 24 (no npm), Chromium libraries and fonts, Xvfb, CloakBrowser binary, prod `node_modules`, `build/` |
| `shopee-login:local` | 1.17 GB                    | The same 11 layers, plus x11vnc (14 MB) and the viewer (0.8 MB)                                                              |

Biggest layers: the CloakBrowser Chromium (483 MB; 656 MB before trimming), system packages (412 MB, of which llvm/mesa is about 180 MB because Chromium's `libgbm1` depends on it), and the node binary (123 MB). What the build does about it:

- The Chromium binary is downloaded at build time, signature-checked, and keyed only on the locked `cloakbrowser` version. Source and dependency changes don't re-download it, and runtime updates are disabled with `CLOAKBROWSER_AUTO_UPDATE=false`. To upgrade, bump `cloakbrowser` in `package-lock.json` and rebuild.
- The build removes `chromedriver` and every UI locale except en-US, id, ms and zh-TW.
- TypeScript compiles in a separate stage. The runtime contains only `npm ci --omit=dev` output and compiled JS, with no npm, TypeScript, ESLint, tests or sources.
- `npm` downloads are cached with BuildKit cache mounts. `.dockerignore` is an allow-list.
- The login viewer (`docker/login-viewer`) is noVNC's ES modules plus a 40-line WebSocket bridge with its own lockfile. It replaces Debian's `novnc`/`websockify`, which pulled in Python, numpy and a second Node.js (205 MB).

## Server setup (once)

Prerequisites: Docker Engine with the Compose v2 plugin, and an SSH login that can run `docker` (member of the `docker` group).

```bash
git clone <your fork> ~/shopee-mcp && cd ~/shopee-mcp
docker network inspect ai-routing >/dev/null 2>&1 || docker network create ai-routing
docker compose --profile login build     # builds both images
docker compose up -d                     # starts shopee-mcp only
```

`SHOPEE_DOMAIN`, `CACHE_TTL_MS` and `DEBUG` can be set in a `.env` file next to `compose.yaml`. Leave `SHOPEE_ACCOUNT_TOOLS` alone: Compose pins it to `off`.

## Sign in / renew the session (from your laptop)

Configure the script once, in `~/.config/shopee-mcp/login.env` or the environment:

```bash
SHOPEE_SSH_HOST=me@homeserver            # or an ~/.ssh/config alias
SHOPEE_REMOTE_DIR=shopee-mcp             # compose dir on the server (absolute or relative to home)
# SHOPEE_SSH_OPTS="-p 22 -i ~/.ssh/id_ed25519"
# SHOPEE_LOCAL_PORT=16080
# SHOPEE_COMPOSE="docker compose"
```

Then run it from a checkout on the laptop:

```bash
scripts/shopee-login
```

It checks the server and stops `shopee-mcp`, then starts `shopee-login` with a one-time VNC password (sent over stdin). It opens an SSH tunnel and launches the viewer in your browser; the URL is also printed. Sign in to Shopee in the viewer, completing the password, OTP and captcha there, then press Enter. The script confirms the session cookie, stops `shopee-login` gracefully (which flushes the profile), starts `shopee-mcp`, waits for it to report healthy, and finally asks the server over MCP (`check_login_status`) whether it is logged in.

On Ctrl-C or any failure it closes the tunnel and the SSH connection and stops `shopee-login`. It restarts `shopee-mcp` only once `shopee-login` is confirmed stopped; otherwise it prints the exact commands to run instead. SSH key authentication is required, because the script runs non-interactively (`BatchMode`).

The viewer is never exposed beyond the server's loopback. The SSH tunnel is the only way in, and x11vnc itself listens only on the container's loopback.

## Day-to-day operation

| Task                  | Command (on the server)                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Start / normal state  | `docker compose up -d`                                                                                                                                       |
| Status / health       | `docker compose ps` (health column), or `docker compose exec shopee-mcp node -e "fetch('http://127.0.0.1:8000/health').then(r=>r.text()).then(console.log)"` |
| Logs                  | `docker compose logs -f shopee-mcp`                                                                                                                          |
| Stop                  | `docker compose stop shopee-mcp`. SIGTERM closes the browser cleanly (about 1s; 30s grace)                                                                   |
| Restart               | `docker compose restart shopee-mcp`                                                                                                                          |
| Update code or images | `scripts/deploy` (see [Deploying updates](#deploying-updates))                                                                                               |

`shopee-mcp` uses `restart: unless-stopped`, so it comes back after a crash or reboot. A container you stopped by hand stays stopped, and that includes one stopped by an interrupted login, so run `docker compose up -d` afterwards. `shopee-login` uses `restart: "no"` and never comes back on its own.

### Deploying updates

Run `scripts/deploy` on the server, or `ssh homeserver shopee-mcp/scripts/deploy` from the laptop. It:

1. checks Docker access and refuses to run while `shopee-login` is up;
2. pulls the current branch, fast-forward only, and restarts itself if the pull changed the script (`--no-pull` deploys the checkout as it is);
3. builds both images and runs `docker compose up -d`, which recreates `shopee-mcp` only when its image changed;
4. waits for the health check, then asks the server over MCP whether the Shopee session is still valid. An expired session is a warning, not a failure: run `scripts/shopee-login`;
5. removes the image versions the build replaced, without `--force`, and prints `docker system df`.

Cleanup touches only this project's two replaced images. It never prunes other projects' images and never touches the `shopee-profile` volume. Docker's build cache is left to its own garbage collection; `docker builder prune` would clear every project's cache.

`/health` is cheap and never launches the browser:

```json
{
  "status": "ok",
  "version": "0.3.0",
  "domain": "shopee.co.id",
  "browser": "idle",
  "accountTools": "off"
}
```

## MCP endpoint

`http://shopee-mcp:8000/mcp` (Streamable HTTP, stateless). Any client container must also be attached to `ai-routing`. Every tool call drives a real page load (see [tool timings](./CONFIGURATION.md#tools-and-request-timeouts)), so give the client a per-call timeout of at least 60–90 s. Calls are queued and served one at a time.

## Resource limits and measurements

Measured on linux/arm64 (Docker Desktop VM on Apple Silicon). The test loaded real `shopee.co.id` search and product pages without a login, so the page weight is real but the logged-in API calls were not exercised.

| Metric                                       | Value                                                           |
| -------------------------------------------- | --------------------------------------------------------------- |
| Idle, before the first call (node only)      | 52 MiB, 0% CPU, 9 tasks                                         |
| Browser started, idle on a page              | 290–450 MiB, about 1% CPU                                       |
| Browser launch                               | about 1 s                                                       |
| Shopee page load, 1 CPU                      | 15–24 s to network idle, with CPU pinned at 100% the whole time |
| Shopee page load, 2 CPUs                     | 5.5–9 s to network idle                                         |
| Peak over 12 consecutive loads (1 GiB limit) | 650 MiB anon, 810 MiB cgroup; plateaus, no growth trend         |
| Peak at a 768 MiB limit                      | Ran at the ceiling under reclaim, no OOM                        |
| Chromium processes                           | 10–13                                                           |
| Peak tasks (`pids_limit` counts threads)     | 160                                                             |
| `/dev/shm` use                               | 0 (Playwright passes `--disable-dev-shm-usage`)                 |
| `/tmp` use (Chromium shared memory)          | up to 61 MB                                                     |

Resulting Compose settings: `mem_limit: 1g`, `cpus: 2.0` (a ceiling only; idle use stays near zero), `pids_limit: 256`, `/tmp` tmpfs of 128m, and the default 64m `shm_size`. Override memory and CPU with `SHOPEE_MCP_MEM_LIMIT` / `SHOPEE_MCP_CPUS` in `.env`.

## Hardening

Both services run as a non-root user (`node`, uid 1000) with `read_only: true`, `cap_drop: [ALL]`, `no-new-privileges`, `init: true`, a PID limit and size-capped JSON logs. All of these were tested with Chromium, Xvfb and x11vnc running. The writable paths are `/tmp` (tmpfs; also `HOME`) and the profile volume.

One deliberate exception: Chromium runs with `--no-sandbox`, as upstream does. Its sandbox needs user namespaces or extra capabilities, which this hardened container does not grant, so the container is the isolation boundary.

## Recovery

| Situation                                                 | What to do                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tools answer "blocked … run `npm run login`"              | The Shopee session expired. Run `scripts/shopee-login` from the laptop. (The message text comes from upstream.)                                                                                        |
| `shopee-mcp` restarts in a loop, logs "profile is in use" | `shopee-login` is still running: `docker compose --profile login stop shopee-login`.                                                                                                                   |
| The login script was killed and `shopee-mcp` is down      | `docker compose --profile login stop shopee-login && docker compose up -d shopee-mcp`                                                                                                                  |
| Chromium crashed inside a running server                  | Nothing to do: the next tool call relaunches the browser.                                                                                                                                              |
| Shopee keeps blocking a fresh login                       | Change the device identity: stop both services, delete `/data/shopee-profile/.shopee-mcp-seed` from the volume, and sign in again. Persistent blocks may also call for real Windows fonts (see below). |

## Known limits

- CloakBrowser presents Linux as a **Windows** browser. Its docs say a Windows persona without real Windows fonts can be flagged, and those fonts are proprietary, so the image cannot ship them. The image installs CloakBrowser's documented font baseline (emoji, CJK and others). To add Windows fonts, copy them into the image under `/usr/local/share/fonts/windows/` (see CloakBrowser's "Font Setup on Linux").
- After a stop, Chromium reports "didn't shut down correctly" because Playwright closes it through CDP. Session cookies are still flushed to disk: a cookie set right before a stop survived a relaunch in testing.
