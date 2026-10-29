# syntax=docker/dockerfile:1.7
#
# Shopee MCP — two runtime targets sharing one browser base:
#
#   build ─┐
#   prod-deps ─┐   browser-fetch ─┐
#              └── browser-runtime-base ──┬── mcp-runtime    (default target)
#                                         └── login-runtime  (+ x11vnc/noVNC)
#
# Both final images inherit every heavy layer (Node, Chromium libraries, fonts,
# CloakBrowser binary, node_modules, compiled app) from browser-runtime-base, so
# Docker stores them once. Login-only packages exist only in login-runtime.

ARG NODE_VERSION=24
ARG DEBIAN_RELEASE=trixie

# ─── Shared slim Node base ────────────────────────────────────────────────────
FROM node:${NODE_VERSION}-${DEBIAN_RELEASE}-slim AS node-base
ENV NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

# ─── Build: dev dependencies + TypeScript compile (never shipped) ─────────────
FROM node-base AS build
WORKDIR /src
COPY package.json package-lock.json ./
# --ignore-scripts: skips husky's `prepare`; no dependency needs an install script.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --sourceMap false --declaration false --declarationMap false

# ─── Production node_modules only ─────────────────────────────────────────────
FROM node-base AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts

# ─── CloakBrowser Chromium binary, fetched at build time ──────────────────────
# Keyed on the locked cloakbrowser version only (extracted to a one-line file),
# so ordinary dependency or source changes never re-download the ~200 MB binary.
FROM node-base AS cloakbrowser-version
COPY package-lock.json /tmp/
RUN node -p "require('/tmp/package-lock.json').packages['node_modules/cloakbrowser'].version" \
      > /cloakbrowser-version

FROM node-base AS browser-fetch
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser
COPY --from=cloakbrowser-version /cloakbrowser-version /tmp/cloakbrowser-version
# The wrapper version pins the Chromium build; `install` verifies the release's
# Ed25519 signature and SHA-256 before extracting.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm install --prefix /tmp/cb --no-save --no-package-lock --ignore-scripts \
      "cloakbrowser@$(cat /tmp/cloakbrowser-version)" \
 && node /tmp/cb/node_modules/cloakbrowser/dist/cli.js install \
 && rm -rf /tmp/cb "$CLOAKBROWSER_CACHE_DIR"/.welcome_shown "$CLOAKBROWSER_CACHE_DIR"/*.tar.gz \
 && test -x "$CLOAKBROWSER_CACHE_DIR"/chromium-*/chrome
# Trim what the service never loads: chromedriver (Playwright drives Chromium
# over CDP) and UI locale packs (177 MB) other than en-US (Chromium's fallback)
# and the Shopee regions' languages (see REGION_DEFAULTS in session.ts).
RUN cd "$CLOAKBROWSER_CACHE_DIR"/chromium-*/ \
 && rm -f chromedriver \
 && find locales -type f ! -name 'en-US.*' ! -name 'en-US_*' ! -name 'id.*' ! -name 'id_*' \
      ! -name 'ms.*' ! -name 'ms_*' ! -name 'zh-TW.*' ! -name 'zh-TW_*' -exec rm -f {} + \
 && ls locales

# ─── Browser runtime base (shared by both final images) ───────────────────────
# Plain Debian slim plus the node binary from the same Node image: the runtime
# gets Node without npm, corepack or yarn.
FROM debian:${DEBIAN_RELEASE}-slim AS browser-runtime-base
COPY --from=node-base /usr/local/bin/node /usr/local/bin/node
RUN groupadd --gid 1000 node \
 && useradd --uid 1000 --gid node --no-create-home --shell /usr/sbin/nologin node
# Chromium runtime libraries and fonts from CloakBrowser's official Dockerfile,
# minus its Python wrapper, xdotool/openbox and curl. The fonts are its
# documented anti-bot baseline (emoji/CJK canvas hashes), not decoration.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 \
      libdbus-1-3 libdrm2 libxkbcommon0 libatspi2.0-0 libxcomposite1 \
      libxdamage1 libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 \
      libcairo2 libasound2 libx11-xcb1 libfontconfig1 libx11-6 \
      libxcb1 libxext6 libxshmfence1 \
      libglib2.0-0 libgtk-3-0 libpangocairo-1.0-0 libcairo-gobject2 \
      libgdk-pixbuf-2.0-0 libxss1 libxtst6 \
      fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-freefont-ttf \
      fonts-ipafont-gothic fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-urw-base35 \
      xvfb \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /usr/share/doc/* /usr/share/man/*

ENV NODE_ENV=production \
    CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false \
    SHOPEE_PROFILE_DIR=/data/shopee-profile \
    SHOPEE_HEADLESS=false \
    SHOPEE_ACCOUNT_TOOLS=off \
    DISPLAY=:99 \
    XVFB_SCREEN=1366x768x24 \
    HOME=/tmp/home \
    XDG_CACHE_HOME=/tmp/home/.cache \
    XDG_CONFIG_HOME=/tmp/home/.config

COPY --from=browser-fetch /opt/cloakbrowser /opt/cloakbrowser

WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json LICENSE ./
COPY --from=build /src/build ./build
COPY docker/entrypoint.sh /usr/local/bin/shopee-entrypoint

# The profile lives on a volume mounted at /data; this only seeds its ownership
# when Docker initialises an empty named volume.
RUN mkdir -p /data/shopee-profile && chown -R node:node /data

USER node
ENTRYPOINT ["shopee-entrypoint"]

# ─── MCP service (default target) ─────────────────────────────────────────────
FROM browser-runtime-base AS mcp-runtime
ENV MCP_TRANSPORT=http \
    MCP_HOST=0.0.0.0 \
    PORT=8000
EXPOSE 8000
# Node's fetch: no curl/wget in the image, and it never launches the browser.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "build/index.js"]

# ─── Login viewer: noVNC + WebSocket bridge (its own lockfile) ────────────────
# Replaces Debian's novnc/websockify, which pull in Python, numpy and a second
# Node.js (~200 MB) for what is a static page and a socket relay.
FROM node-base AS login-viewer
WORKDIR /opt/login-viewer
COPY docker/login-viewer/package.json docker/login-viewer/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts
COPY docker/login-viewer/server.js docker/login-viewer/index.html ./

# ─── Login session (temporary; started only for re-authentication) ────────────
FROM browser-runtime-base AS login-runtime
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends x11vnc \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* /usr/share/doc/* /usr/share/man/*
COPY --from=login-viewer /opt/login-viewer /opt/login-viewer
COPY docker/login.sh /usr/local/bin/shopee-login-session
USER node
ENV LOGIN_HTTP_PORT=6080
EXPOSE 6080
CMD ["shopee-login-session"]
