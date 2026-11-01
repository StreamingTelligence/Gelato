import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { loadTlsMaterial } from './dist/transportConfig.js';

// Public device-only ingress. The full Controller must listen on loopback.
const host = process.env.INGRESS_HOST;
const port = Number(process.env.INGRESS_PORT);
const upstreamHost = process.env.INGRESS_UPSTREAM_HOST ?? '127.0.0.1';
const upstreamPort = Number(process.env.INGRESS_UPSTREAM_PORT);
const publicUrl = process.env.PUBLIC_CONTROLLER_URL;
if (!host || !Number.isInteger(port) || port < 1 || port > 65535
    || upstreamHost !== '127.0.0.1' || !Number.isInteger(upstreamPort)
    || upstreamPort < 1 || upstreamPort > 65535 || port === upstreamPort
    || !publicUrl || new URL(publicUrl).protocol !== 'https:'
    || !process.env.TLS_KEY || !process.env.TLS_CERT) {
  throw new Error('Explicit public TLS and loopback upstream configuration is required');
}
const origin = new URL(publicUrl);
if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password
    || Number(origin.port || 443) !== port) {
  throw new Error('PUBLIC_CONTROLLER_URL must match the public ingress root origin');
}

const tlsConfig = {
  host, port, mode: 'direct', publicOrigin: origin.origin,
  keyPath: process.env.TLS_KEY, certPath: process.env.TLS_CERT
};
let material = loadTlsMaterial(tlsConfig);
const server = https.createServer({
  key: material.key, cert: material.cert, minVersion: 'TLSv1.2', maxHeaderSize: 16_384
}, (request, response) => {
  const route = permitted(request, false);
  if (!route) {
    request.resume();
    response.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('Not found');
    return;
  }
  const headers = proxyHeaders(request);
  const upstream = http.request({
    host: upstreamHost, port: upstreamPort, method: request.method,
    path: request.url, headers, timeout: 30_000
  }, incoming => {
    response.writeHead(incoming.statusCode ?? 502, incoming.headers);
    incoming.pipe(response);
  });
  upstream.on('timeout', () => upstream.destroy(new Error('Upstream timeout')));
  upstream.on('error', () => {
    if (!response.headersSent) response.writeHead(502, { 'cache-control': 'no-store' });
    response.end();
  });
  request.on('aborted', () => upstream.destroy());
  request.pipe(upstream);
});
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;

server.on('upgrade', (request, socket, head) => {
  if (!permitted(request, true) || request.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
    return;
  }
  const upstream = net.connect({ host: upstreamHost, port: upstreamPort });
  upstream.once('connect', () => {
    const headers = proxyHeaders(request);
    headers.connection = 'Upgrade';
    headers.upgrade = 'websocket';
    const lines = [`GET ${request.url} HTTP/1.1`];
    for (const [name, value] of Object.entries(headers)) {
      if (Array.isArray(value)) for (const item of value) lines.push(`${name}: ${item}`);
      else if (value !== undefined) lines.push(`${name}: ${value}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

function permitted(request, websocket) {
  if (!request.url || request.url.length > 2048) return false;
  let url;
  try { url = new URL(request.url, origin); } catch { return false; }
  if (url.origin !== origin.origin || url.hash) return false;
  const path = url.pathname;
  // Some small-device WebSocket clients omit the non-default port from Host.
  // Accept that form only for the allowlisted device sockets, never for HTTP
  // routes or the private Controller console.
  const agentSocket = websocket && (path === '/agent/control' || path === '/agent/streams/live'
    || /^\/agent\/streams\/str_[A-Za-z0-9_-]{10,80}$/.test(path));
  if (request.headers.host !== origin.host
      && !(agentSocket && request.headers.host === origin.hostname)) return false;
  if (websocket) {
    if (request.method !== 'GET') return false;
    if (agentSocket) {
      return !url.search;
    }
    return /^\/packet-overlay\/dev_[A-Za-z0-9_-]{10,80}$/.test(path);
  }
  if (url.search) return false;
  // The device example creates pairing requests from a WebView. Its JSON POST
  // and authenticated polling/deletion need CORS preflights to reach the
  // Controller's CORS middleware; keep the allowlist limited to these routes.
  const preflightMethod = request.headers['access-control-request-method'];
  if (path === '/pairing-requests') {
    return request.method === 'POST'
      || (request.method === 'OPTIONS' && preflightMethod === 'POST');
  }
  if (/^\/pairing-requests\/pr_[A-Za-z0-9_-]{10,80}$/.test(path)) {
    return request.method === 'GET' || request.method === 'DELETE'
      || (request.method === 'OPTIONS'
        && (preflightMethod === 'GET' || preflightMethod === 'DELETE'));
  }
  return /^\/agent\/streams\/str_[A-Za-z0-9_-]{10,80}\/content$/.test(path)
    && request.method === 'GET';
}

function proxyHeaders(request) {
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    if (name === 'forwarded' || name.startsWith('x-forwarded-')
        || name === 'x-gelato-peer-ip' || name === 'proxy-authorization') delete headers[name];
  }
  headers.host = origin.host;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-for'] = request.socket.remoteAddress ?? '';
  return headers;
}

const reload = setInterval(() => {
  try {
    const updated = loadTlsMaterial(tlsConfig);
    if (updated.fingerprint !== material.fingerprint) {
      server.setSecureContext({ key: updated.key, cert: updated.cert, minVersion: 'TLSv1.2' });
      material = updated;
    }
  } catch (error) {
    console.error('TLS reload rejected:', error instanceof Error ? error.message : String(error));
  }
  if (Date.now() >= material.expiresAt) server.close();
}, 30_000);
reload.unref();
server.once('close', () => clearInterval(reload));
server.listen(port, host, () => console.log(`Device ingress listening on ${host}:${port}`));
