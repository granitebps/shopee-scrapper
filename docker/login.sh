#!/bin/sh
# Temporary login session: the browser on Xvfb, shared over VNC (container
# loopback only) and a noVNC viewer on LOGIN_HTTP_PORT (docker/login-viewer).
# Compose publishes that port on the host's 127.0.0.1 only; reach it through an
# SSH tunnel (scripts/shopee-login).
set -eu

if [ -n "${LOGIN_VNC_PASSWORD:-}" ]; then
  x11vnc -storepasswd "$LOGIN_VNC_PASSWORD" /tmp/vncpasswd >/dev/null 2>&1
  set -- -rfbauth /tmp/vncpasswd
else
  set -- -nopw
fi

x11vnc -display "$DISPLAY" -localhost -rfbport 5900 -forever -shared -quiet -bg \
  -o /tmp/x11vnc.log "$@"
node /opt/login-viewer/server.js &

exec node build/login-service.js
