// Local dev server: same behaviour as the Cloudflare Worker (static files + /proxy/*),
// so the app can be run and tested without a Cloudflare account.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { handleProxy } from './proxy.js';

const PORT = Number(process.env.PORT) || 5173;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function toRequest(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return new Request(new URL(req.url, `http://${req.headers.host}`), {
    method: req.method,
    headers: Object.entries(req.headers).filter(([, v]) => typeof v === 'string'),
    body: chunks.length ? Buffer.concat(chunks) : undefined,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname.startsWith('/proxy/')) {
    try {
      const response = await handleProxy(await toRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res);
      else res.end();
    } catch (err) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end(`Proxy error: ${err.message}`);
    }
    return;
  }

  const file = path.join(PUBLIC, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname));
  if (!file.startsWith(PUBLIC)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
  }
});

server.listen(PORT, () => console.log(`profixio-live running at http://localhost:${PORT}`));
