import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createTeraboxApi, ExpiredDownloadLinkError, TeraboxApiError } from './terabox-api.js';
import { parseShareUrl } from './teradl.js';

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/download-error.js', ['download-error.js', 'text/javascript; charset=utf-8']]
]);
const lookupTtl = 30 * 60_000;
const refreshCooldown = 60_000;
const maxLookups = 100;
const maxActiveJobs = 2;
const maxDownloadStatuses = 100;
const downloadIdleTimeout = 90_000;

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
  const directories = new Map();
  const pending = new Map();
  const downloadStatuses = new Map();
  let activeJobs = 0;

  async function loadDirectory(shareUrl, dirPath, rejectedListing) {
    const key = JSON.stringify([shareUrl, dirPath]);
    if (pending.has(key)) return pending.get(key);
    const cached = directories.get(key);
    if (cached?.expires > Date.now() && cached !== rejectedListing) return cached;

    // A shared request can finish even if one of its callers disconnects.
    const request = (async () => {
      const entries = await provider.list(shareUrl, dirPath, AbortSignal.timeout(interactionTimeout));
      const listing = {
        ...parseEntries(entries, dirPath),
        id: randomUUID(),
        key,
        shareUrl,
        dirPath,
        expires: Date.now() + lookupTtl,
        refreshedAt: rejectedListing ? Date.now() : 0
      };
      if (lookups.size >= maxLookups) {
        const [oldId, oldListing] = lookups.entries().next().value;
        lookups.delete(oldId);
        if (directories.get(oldListing.key) === oldListing) directories.delete(oldListing.key);
      }
      lookups.set(listing.id, listing);
      directories.set(key, listing);
      return listing;
    })();
    pending.set(key, request);
    try {
      return await request;
    } catch (error) {
      if (rejectedListing) rejectedListing.refreshedAt = Date.now();
      throw error;
    } finally {
      pending.delete(key);
    }
  }

  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; frame-ancestors 'self'; form-action 'self'; base-uri 'none'");
    const url = URL.parse(req.url, 'http://teradown.local');
    if (!url) return fail(res, 400, 'Alamat permintaan tidak valid.');
    const { pathname } = url;
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
    const status = req.method === 'GET' && pathname.match(/^\/api\/download-status\/([a-f0-9]{32})$/);
    if (!lookup && !download && !folder && !status) return fail(res, 404, 'Halaman tidak ditemukan.');
    if (req.headers['sec-fetch-site'] === 'cross-site') return fail(res, 403, 'Buka Teradown untuk melanjutkan.', download);
    if (status) {
      const progress = downloadStatuses.get(status[1]);
      if (!progress) return fail(res, 404, 'Status unduhan belum tersedia.');
      return sendJson(res, 200, progress);
    }

    let progress;
    const progressId = download && url.searchParams.get('progress');
    if (progressId && /^[a-f0-9]{32}$/.test(progressId)) {
      if (downloadStatuses.has(progressId)) {
        return fail(res, 409, 'Unduhan ini sudah diminta.', download);
      }
      if (downloadStatuses.size >= maxDownloadStatuses) {
        for (const [id, entry] of downloadStatuses) {
          if (!['complete', 'failed'].includes(entry.state)) continue;
          downloadStatuses.delete(id);
          break;
        }
      }
      progress = { state: 'preparing', bytes: 0, total: null };
      downloadStatuses.set(progressId, progress);
    }
    const failRequest = (statusCode, message) => {
      if (progress) Object.assign(progress, { state: 'failed', message });
      if (!res.destroyed && !res.headersSent) fail(res, statusCode, message, download);
    };

    let shareUrl;
    let selected;
    let originalListing;
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
        return failRequest(410, 'Daftar file sudah kedaluwarsa. Tampilkan ulang tautannya.');
      }
      const offset = Number(index) - 1;
      dirPath = entry.dirPath;
      if (folder) {
        const next = entry.folders[offset];
        if (!next) return fail(res, 404, 'Folder tidak ditemukan.');
        dirPath = next.path;
      } else {
        selected = entry.files[offset];
        if (!selected) return failRequest(404, 'File tidak ditemukan.');
        originalListing = entry;
      }
      shareUrl = entry.shareUrl;
    }

    if (activeJobs >= maxActiveJobs) return failRequest(503, 'Teradown sedang memproses unduhan lain. Coba lagi sebentar.');
    activeJobs += 1;
    const controller = new AbortController();
    const disconnect = () => {
      if (!res.writableFinished) controller.abort();
    };
    res.once('close', disconnect);
    const deadline = setTimeout(
      () => controller.abort(new DOMException('Unduhan tidak aktif.', 'TimeoutError')),
      download ? downloadIdleTimeout : interactionTimeout
    );
    try {
      if (!download) {
        const { id, files, folders } = await loadDirectory(shareUrl, dirPath);
        controller.signal.throwIfAborted();
        sendJson(res, 200, {
          folders: folders.map(({ name }, index) => ({ name, open: `/api/folder/${id}/${index + 1}` })),
          files: files.map(({ name, size, link }, index) => ({
            name, size, file: index + 1, download: link ? `/api/download/${id}/${index + 1}` : null
          }))
        });
        return;
      }

      const cached = directories.get(originalListing.key);
      const listing = cached?.expires > Date.now() ? cached : originalListing;
      const findSelected = (directory) => {
        const file = directory.files.find(({ id }) => id === selected.id);
        if (!file) throw new TeraboxApiError('Daftar file berubah. Tampilkan ulang tautannya.', 409);
        return file;
      };
      let current = findSelected(listing);
      let response;
      try {
        response = await provider.download(current.link, controller.signal);
      } catch (error) {
        if (!(error instanceof ExpiredDownloadLinkError) || Date.now() - listing.refreshedAt < refreshCooldown) {
          throw error;
        }
        controller.signal.throwIfAborted();
        current = findSelected(await loadDirectory(shareUrl, dirPath, listing));
        response = await provider.download(current.link, controller.signal);
      }
      const headers = {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': attachment(current.name)
      };
      const length = response.headers.get('content-length');
      if (/^\d+$/.test(length) && !response.headers.has('content-encoding')) {
        headers['Content-Length'] = length;
      }
      const total = Number(headers['Content-Length']);
      if (progress) Object.assign(progress, {
        state: 'transferring', total: Number.isSafeInteger(total) ? total : null
      });
      const trackTransfer = new Transform({
        transform(chunk, encoding, callback) {
          deadline.refresh();
          if (progress) progress.bytes += chunk.length;
          callback(null, chunk);
        }
      });
      res.writeHead(200, headers);
      await pipeline(response.body, trackTransfer, res, { signal: controller.signal });
      if (progress && progress.total !== null && progress.bytes !== progress.total) {
        return failRequest(502, 'Ukuran transfer tidak sesuai. Silakan unduh ulang.');
      }
      if (progress) progress.state = 'complete';
    } catch (error) {
      const timedOut = (controller.signal.reason ?? error).name === 'TimeoutError';
      const statusCode = timedOut ? 504 : error instanceof TeraboxApiError ? error.status : 502;
      const message = timedOut ? 'Waktu tunggu terlampaui. Silakan coba lagi.'
        : error instanceof TeraboxApiError ? error.message
        : download ? 'Transfer unduhan terputus. Silakan coba lagi.' : 'Permintaan TeraboxAPI gagal. Coba lagi sebentar.';
      failRequest(statusCode, message);
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
