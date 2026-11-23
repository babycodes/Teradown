import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createTeraboxApi, TeraboxApiError } from './terabox-api.js';
import { parseShareUrl } from './teradl.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/download-error.js', ['download-error.js', 'text/javascript; charset=utf-8']]
]);
const lookupTtl = 30 * 60_000;
const maxLookups = 100;
const maxActiveJobs = 2;

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function fail(res, status, message, download) {
  if (!download) return sendJson(res, status, { error: message });
  // The invisible iframe reports failures without replacing the file list.
  const escaped = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;');
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><html lang="id"><meta charset="utf-8"><title>Unduhan gagal</title><body><p>${escaped}</p><script src="/download-error.js"></script></body></html>`);
}

async function readLookup(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new Error('Gunakan formulir tautan Teradown.');
  }
  let body = '';
  for await (const chunk of req.setEncoding('utf8').iterator({ destroyOnReturn: false })) {
    body += chunk;
    if (body.length > 4096) {
      req.resume();
      throw new Error('Tautan terlalu panjang.');
    }
  }
  return parseShareUrl(JSON.parse(body)?.url);
}

function attachment(name) {
  const filename = name.toWellFormed().replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 220).toWellFormed();
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename || 'download').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`;
}

function parseEntries(entries, dirPath) {
  const folders = [];
  const files = [];
  for (const entry of entries) {
    const name = entry?.server_filename;
    if (typeof name !== 'string' || !name.trim()) continue;
    if ([1, '1', true].includes(entry.isdir)) {
      if (!name.includes('/') && name !== '.' && name !== '..') {
        const path = typeof entry.path === 'string' && entry.path.startsWith('/')
          ? entry.path : `${dirPath}/${name}`;
        folders.push({ name, path });
      }
      continue;
    }
    if (typeof entry.fs_id !== 'string' && !Number.isSafeInteger(entry.fs_id)) continue;
    const size = typeof entry.formatted_size === 'string' ? entry.formatted_size : null;
    files.push({ id: String(entry.fs_id), name, size, link: entry.direct_link });
  }
  return { files, folders };
}

export function createTeradownServer({ provider = createTeraboxApi(), interactionTimeout = 25_000 } = {}) {
  const lookups = new Map();
  let activeJobs = 0;

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
    const pathname = URL.parse(req.url, 'http://teradown.local')?.pathname;
    if (!pathname) return fail(res, 400, 'Alamat permintaan tidak valid.');
    const asset = req.method === 'GET' && assets.get(pathname);
    if (asset) {
      const [file, type] = asset;
      try {
        const body = await readFile(new URL(`../public/${file}`, import.meta.url));
        res.writeHead(200, { 'Content-Type': type });
        res.end(body);
      } catch {
        sendJson(res, 500, { error: 'Aset Teradown tidak dapat dibuka.' });
      }
      return;
    }

    const lookup = req.method === 'POST' && pathname === '/api/files';
    const folder = req.method === 'POST' && pathname.match(/^\/api\/folder\/([\da-f-]{36})\/(\d+)$/);
    const download = req.method === 'GET' && pathname.match(/^\/api\/download\/([\da-f-]{36})\/(\d+)$/);
    if (!lookup && !download && !folder) return fail(res, 404, 'Halaman tidak ditemukan.');
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'Buka Teradown untuk melanjutkan.', download);

    let shareUrl;
    let selected;
    let dirPath = '';
    if (lookup) {
      try {
        shareUrl = await readLookup(req);
      } catch (error) {
        return fail(res, 400, error instanceof SyntaxError ? 'Masukkan tautan TeraBox yang valid.' : error.message);
      }
    } else {
      const [, id, index] = download || folder;
      const entry = lookups.get(id);
      if (!entry || entry.expires < Date.now()) {
        lookups.delete(id);
        return fail(res, 410, 'Daftar file sudah kedaluwarsa. Tampilkan ulang tautannya.', download);
      }
      const offset = Number(index) - 1;
      dirPath = entry.dirPath;
      if (folder) {
        const next = entry.folders[offset];
        if (!next) return fail(res, 404, 'Folder tidak ditemukan.');
        dirPath = next.path;
      } else {
        selected = entry.files[offset];
        if (!selected) return fail(res, 404, 'File tidak ditemukan.', download);
      }
      shareUrl = entry.shareUrl;
    }

    if (activeJobs >= maxActiveJobs) return fail(res, 503, 'Teradown sedang memproses unduhan lain. Coba lagi sebentar.', download);
    activeJobs += 1;
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    res.once('close', disconnect);
    const deadline = setTimeout(disconnect, download ? 240_000 : interactionTimeout);
    try {
      const entries = await provider.list(shareUrl, dirPath, controller.signal);
      const { files, folders } = parseEntries(entries, dirPath);
      if (!download) {
        for (const [id, entry] of lookups) {
          if (entry.expires < Date.now()) lookups.delete(id);
        }
        if (lookups.size >= maxLookups) lookups.delete(lookups.keys().next().value);
        const id = randomUUID();
        lookups.set(id, {
          shareUrl, dirPath, folders, files: files.map(({ id }) => ({ id })), expires: Date.now() + lookupTtl
        });
        sendJson(res, 200, {
          folders: folders.map(({ name }, index) => ({ name, open: `/api/folder/${id}/${index + 1}` })),
          files: files.map(({ name, size, link }, index) => ({
            name, size, file: index + 1, download: link ? `/api/download/${id}/${index + 1}` : null
          }))
        });
        return;
      }

      const current = files.find(({ id }) => id === selected.id);
      if (!current) return fail(res, 409, 'Daftar file berubah. Tampilkan ulang tautannya.', download);
      const response = await provider.download(current.link, controller.signal);
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachment(current.name)
      };
      const length = response.headers.get('content-length');
      if (/^\d+$/.test(length) && !response.headers.has('content-encoding')) {
        headers['Content-Length'] = length;
      }
      res.writeHead(200, headers);
      await pipeline(response.body, res, { signal: controller.signal });
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        const status = controller.signal.aborted ? 504 : error instanceof TeraboxApiError ? error.status : 502;
        const message = status === 504 ? 'Waktu tunggu terlampaui. Silakan coba lagi.'
          : error instanceof TeraboxApiError ? error.message : 'Permintaan TeraboxAPI gagal. Coba lagi sebentar.';
        fail(res, status, message, download);
      }
    } finally {
      clearTimeout(deadline);
      res.off('close', disconnect);
      activeJobs -= 1;
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.loadEnvFile(new URL('../.env', import.meta.url));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 9876);
  createTeradownServer().listen(port, host, () => {
    console.log(`Teradown berjalan di http://${host}:${port}`);
  });
}
