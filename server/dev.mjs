// Local dev server: serves ./public and emulates /api/signal with an in-memory
// store (same logic as the Netlify function). Usage: npm run dev
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createSignaling } from '../netlify/lib/signal-core.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const port = Number(process.env.PORT) || 8888;

const memory = new Map();
const store = {
  get: async (k) => (memory.has(k) ? structuredClone(memory.get(k)) : null),
  set: async (k, v) => void memory.set(k, structuredClone(v)),
  del: async (k) => void memory.delete(k),
  list: async (prefix) => [...memory.keys()].filter((k) => k.startsWith(prefix)),
};
const signal = createSignaling(store, (name) => process.env[name]);

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/signal') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const response = await signal(
        new Request(url, { method: req.method, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }),
      );
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
    let file = join(root, path);
    if (!file.startsWith(root)) throw Object.assign(new Error('forbidden'), { code: 'ENOENT' });
    let info = await stat(file).catch(() => null);
    if (!info || info.isDirectory()) {
      file = join(root, 'index.html'); // SPA fallback (e.g. /123 join links)
      info = await stat(file);
    }
    res.writeHead(200, {
      'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(await readFile(file));
  } catch (err) {
    res.writeHead(err.code === 'ENOENT' ? 404 : 500);
    res.end(String(err.message || err));
  }
}).listen(port, () => {
  console.log(`\nStreamCast (local)\n  Sur ce PC      → http://localhost:${port}`);
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`  Sur le Wi-Fi   → http://${a.address}:${port}`);
    }
  }
  console.log('');
});
