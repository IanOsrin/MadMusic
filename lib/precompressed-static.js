/**
 * lib/precompressed-static.js — boot-time brotli/gzip cache for static text assets.
 *
 * express.static recompresses every text asset (.js/.css/.svg) on EVERY request
 * via the global `compression` middleware, which runs brotli at quality 4
 * (tuned for speed on dynamic responses). For *static* files that content never
 * changes, so we can afford the slow-but-tiny brotli quality 11 ONCE at boot and
 * serve the pre-built buffer on every hit. Net effect at the 10k-concurrent
 * target: ~22% smaller JS/CSS payloads AND zero per-request compression CPU.
 *
 * This middleware mounts AFTER `compression` and BEFORE `express.static`. Because
 * it sets `Content-Encoding`, the compression middleware sees an already-encoded
 * response and skips it (see compression/index.js "already encoded"). Requests it
 * doesn't handle (no matching asset, no acceptable encoding, x-no-compression)
 * fall through to express.static untouched, so behaviour is a strict superset.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const COMPRESSIBLE = /\.(js|css|svg)$/i;

const MIME = {
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.svg': 'image/svg+xml'
};

function buildAsset(filePath) {
  const raw = fs.readFileSync(filePath);
  const br = zlib.brotliCompressSync(raw, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
    }
  });
  const gz = zlib.gzipSync(raw, { level: 9 });
  // Strong ETag derived from content — stable across workers/boots so the
  // 1h must-revalidate tier can answer If-None-Match with a cheap 304.
  const etag = '"' + crypto.createHash('sha1').update(raw).digest('base64').slice(0, 27) + '"';
  return { br, gz, etag, type: MIME[path.extname(filePath).toLowerCase()], filePath };
}

/**
 * @param {string} rootDir absolute path served as the web root (PUBLIC_DIR)
 * @param {(filePath:string)=>string} cacheControlFor returns the Cache-Control
 *        value for a given on-disk path — reused verbatim from express.static's
 *        setHeaders so the two layers never disagree.
 * @returns {import('express').RequestHandler}
 */
export function createPrecompressedStatic(rootDir, cacheControlFor) {
  const cache = new Map(); // url path ("/js/foo.js") -> asset
  let count = 0;
  let rawBytes = 0;
  let brBytes = 0;

  (function scan(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(full);
      } else if (COMPRESSIBLE.test(entry.name)) {
        const asset = buildAsset(full);
        const urlPath = '/' + path.relative(rootDir, full).split(path.sep).join('/');
        cache.set(urlPath, asset);
        count++;
        rawBytes += fs.statSync(full).size;
        brBytes += asset.br.length;
      }
    }
  })(rootDir);

  const middleware = function precompressedStatic(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.headers['x-no-compression']) return next();

    const asset = cache.get(req.path);
    if (!asset) return next();

    const accept = req.headers['accept-encoding'] || '';
    let body;
    let encoding;
    if (/(^|[\s,])br($|[\s,;])/.test(accept)) {
      body = asset.br;
      encoding = 'br';
    } else if (/(^|[\s,])gzip($|[\s,;])/.test(accept)) {
      body = asset.gz;
      encoding = 'gzip';
    } else {
      return next(); // client wants identity — let express.static serve raw bytes
    }

    res.setHeader('Content-Type', asset.type);
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', asset.etag);
    res.setHeader('Cache-Control', cacheControlFor(asset.filePath));

    if (req.headers['if-none-match'] === asset.etag) {
      res.statusCode = 304;
      return res.end();
    }

    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    res.end(body);
  };

  middleware.stats = { count, rawBytes, brBytes };
  return middleware;
}
