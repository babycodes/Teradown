import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { enterFolder, listFiles, listFolders, parseShareUrl, startBrowserDownload, submitShare } from './teradl.js';

const site = 'https://1024teradl.com/';
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

async function withPage(signal, timeout, usePage) {
  const workspace = await mkdtemp(join(tmpdir(), 'teradown-web-'));
  let browser;
  const close = () => { void browser?.close().catch(() => {}); };
  try {
    browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: true,
      downloadsPath: workspace,
      timeout,
      env: { ...process.env, XDG_CACHE_HOME: workspace, XDG_CONFIG_HOME: workspace }
    });
    signal.throwIfAborted();
    signal.addEventListener('abort', close, { once: true });
    const page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(timeout);
    return await usePage(page);
  } finally {
    signal.removeEventListener('abort', close);
    await browser?.close();
    await rm(workspace, { recursive: true, force: true });
  }
}

function attachment(name) {
  const filename = name.toWellFormed().replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 220).toWellFormed();
  return `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(filename || 'download').replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`;
}

function upstreamMessage(error) {
  if (error.message.startsWith('Daftar folder berubah.')) return error.message;
  if (/ERR_(TUNNEL_CONNECTION_FAILED|BLOCKED_BY_ADMINISTRATOR|NAME_NOT_RESOLVED|CERT_)/.test(error.message)) {
    return 'Server Teradown tidak dapat menjangkau 1024Teradl atau host unduhannya.';
  }
  if (error.name === 'TimeoutError' || /tidak ada URL atau unduhan/i.test(error.message)) {
    return '1024Teradl belum memberikan hasil. Layanan mungkin sedang lambat atau meminta verifikasi di browser.';
  }
  return '1024Teradl tidak dapat menyelesaikan permintaan. Coba lagi sebentar.';
}

export function createTeradownServer({ siteUrl = site, interactionTimeout = 25_000 } = {}) {
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
    let parents = [];
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
      parents = entry.parents;
      if (folder) {
        const name = entry.folders[offset];
        if (name === undefined) return fail(res, 404, 'Folder tidak ditemukan.');
        parents = [...parents, { index: offset, name }];
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
    const deadline = setTimeout(disconnect, download ? 240_000 : interactionTimeout * (3 + parents.length));
    try {
      await withPage(controller.signal, interactionTimeout, async (page) => {
        let buttons = await submitShare(page, siteUrl, shareUrl);
        for (const parent of parents) buttons = await enterFolder(page, parent);
        const files = await listFiles(buttons);
        if (!download) {
          const folders = await listFolders(page);
          for (const [id, entry] of lookups) {
            if (entry.expires < Date.now()) lookups.delete(id);
          }
          if (lookups.size >= maxLookups) lookups.delete(lookups.keys().next().value);
          const id = randomUUID();
          lookups.set(id, { shareUrl, files, folders, parents, expires: Date.now() + lookupTtl });
          sendJson(res, 200, {
            folders: folders.map((name, index) => ({ name, open: `/api/folder/${id}/${index + 1}` })),
            files: files.map((file) => ({ ...file, download: `/api/download/${id}/${file.file}` }))
          });
          return;
        }
        const current = files[selected.file - 1];
        if (!current || current.name !== selected.name || current.action !== selected.action) {
          fail(res, 409, 'Daftar file berubah. Tampilkan ulang tautannya.', download);
          return;
        }

        const result = await startBrowserDownload(page, buttons.nth(selected.file - 1), interactionTimeout);
        const path = await result.path();
        const { size } = await stat(path);
        res.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': size,
          'Content-Disposition': attachment(current.name || result.suggestedFilename())
        });
        await pipeline(createReadStream(path), res, { signal: controller.signal });
      });
    } catch (error) {
      if (!res.destroyed && !res.headersSent) {
        fail(res, controller.signal.aborted ? 504 : 502,
          controller.signal.aborted ? 'Waktu tunggu terlampaui. Silakan coba lagi.' : upstreamMessage(error), download);
      }
    } finally {
      clearTimeout(deadline);
      res.off('close', disconnect);
      activeJobs -= 1;
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.HOST || '0.0.0.0';
  const port = Number(process.env.PORT || 9876);
  createTeradownServer().listen(port, host, () => {
    console.log(`Teradown berjalan di http://${host}:${port}`);
  });
}
