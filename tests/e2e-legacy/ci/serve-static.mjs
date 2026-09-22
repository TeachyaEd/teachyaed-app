#!/usr/bin/env node
// Minimal zero-dependency static file server for the ephemeral staging
// artifact. Serves a single directory (default: ../.staging-artifact) on
// 127.0.0.1 only -- never binds 0.0.0.0, since this is meant to be a
// throwaway local target for Playwright inside one CI job, not a
// deployment.

import { createServer } from 'http';
import { readFile, stat } from 'fs/promises';
import { resolve, extname, join, dirname, relative, isAbsolute } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const ROOT = resolve(process.argv[2] || resolve(__dirname, '../.staging-artifact'));
const PORT = Number(process.env.E2E_PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const server = createServer(async (req, res) => {
  try {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const relPath = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = resolve(join(ROOT, relPath));

    // Prevent path traversal outside ROOT. A plain filePath.startsWith(ROOT)
    // check is unsafe: a sibling directory that merely shares ROOT as a
    // string prefix (e.g. ROOT + "-evil") would incorrectly pass. Using
    // path.relative() and checking it doesn't escape upward (or resolve to
    // an absolute path, which only happens on Windows-style drive-root
    // mismatches) is the correct containment check.
    const rel = relative(ROOT, filePath);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    await stat(filePath);
    const body = await readFile(filePath);
    const ext = extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[serve-static] serving ${ROOT} at http://127.0.0.1:${PORT}`);
});
