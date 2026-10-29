// Serves the noVNC viewer and bridges its WebSocket to x11vnc on the
// container's loopback — the only thing websockify did, without Python.
//
//   GET /             index.html (the viewer)
//   GET /novnc/...    noVNC's ES modules from node_modules
//   WS  /websockify   raw RFB bytes <-> 127.0.0.1:VNC_PORT
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { dirname, join, normalize, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath, URL } from 'node:url';
import { WebSocketServer } from 'ws';

const PORT = Number.parseInt(process.env.LOGIN_HTTP_PORT || '6080', 10);
const VNC_PORT = Number.parseInt(process.env.LOGIN_VNC_PORT || '5900', 10);

const root = dirname(fileURLToPath(import.meta.url));
const novncRoot = join(root, 'node_modules', '@novnc', 'novnc');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

function resolveFile(pathname) {
  if (pathname === '/' || pathname === '/index.html') return join(root, 'index.html');
  if (!pathname.startsWith('/novnc/')) return null;
  const file = join(novncRoot, normalize(pathname.slice('/novnc/'.length)));
  return file.startsWith(novncRoot + sep) && file.endsWith('.js') ? file : null;
}

const server = createServer((req, res) => {
  const file = resolveFile(new URL(req.url ?? '/', 'http://localhost').pathname);
  if (!file || req.method !== 'GET') {
    res.writeHead(404).end();
    return;
  }
  const stream = createReadStream(file);
  stream.on('open', () => {
    res.writeHead(200, {
      'content-type': TYPES[file.slice(file.lastIndexOf('.'))] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    stream.pipe(res);
  });
  stream.on('error', () => res.writeHead(404).end());
});

const wss = new WebSocketServer({ server, path: '/websockify' });
wss.on('connection', (ws) => {
  const vnc = connect(VNC_PORT, '127.0.0.1');
  vnc.on('data', (chunk) => ws.send(chunk));
  ws.on('message', (data) => vnc.write(data));
  vnc.on('close', () => ws.close());
  vnc.on('error', () => ws.close());
  ws.on('close', () => vnc.destroy());
  ws.on('error', () => vnc.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  process.stdout.write(`[shopee-login] Viewer on port ${PORT} (VNC 127.0.0.1:${VNC_PORT})\n`);
});
