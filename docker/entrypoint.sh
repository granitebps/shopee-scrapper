#!/bin/sh
# Shared entrypoint for the shopee-mcp and shopee-login containers.
#
#   1. Take an exclusive lock on the persistent profile, so two browsers can
#      never open it at once (the lock is a kernel flock on the shared volume,
#      released automatically when the container's processes exit).
#   2. Clear Chromium's singleton files left by a previous container: they name
#      that container's hostname, and holding the lock proves nothing uses them.
#   3. Load (or create once) the fingerprint seed stored with the profile.
#   4. Start Xvfb — Shopee detects headless, so the browser runs headed.
set -eu

log() { echo "[shopee-entrypoint] $*" >&2; }

PROFILE_DIR="${SHOPEE_PROFILE_DIR:-/data/shopee-profile}"
LOCK_FILE="${SHOPEE_PROFILE_LOCK:-$(dirname "$PROFILE_DIR")/.shopee-profile.lock}"
mkdir -p "$PROFILE_DIR" "$HOME"

exec 9>>"$LOCK_FILE"
if ! flock -n 9; then
  log "Profile $PROFILE_DIR is in use by another container (lock: $LOCK_FILE)."
  log "Stop the other shopee-mcp / shopee-login container first."
  exit 75
fi

rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie"

if [ -z "${SHOPEE_FINGERPRINT_SEED:-}" ]; then
  SEED_FILE="$PROFILE_DIR/.shopee-mcp-seed"
  if [ ! -s "$SEED_FILE" ]; then
    echo $(( $(od -An -N2 -tu2 /dev/urandom) % 90000 + 10000 )) > "$SEED_FILE"
    log "Created fingerprint seed for this profile."
  fi
  SHOPEE_FINGERPRINT_SEED=$(cat "$SEED_FILE")
  export SHOPEE_FINGERPRINT_SEED
fi

DISPLAY_NUM="${DISPLAY#:}"
rm -f "/tmp/.X${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X${DISPLAY_NUM}"
Xvfb "$DISPLAY" -screen 0 "${XVFB_SCREEN:-1366x768x24}" -nolisten tcp -nolisten local 2>/dev/null &
i=0
until [ -S "/tmp/.X11-unix/X${DISPLAY_NUM}" ]; do
  i=$((i + 1))
  if [ "$i" -gt 100 ]; then
    log "Xvfb did not start."
    exit 1
  fi
  sleep 0.1
done

exec "$@"
