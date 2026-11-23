import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { getDownload, listFiles, parseShareUrl, submitShare } from '../src/teradl.js';
import { createTeradownServer } from '../src/web.js';
import { createTeraboxApi } from '../src/terabox-api.js';

const share = 'https://1024terabox.com/s/local-smoke-test';
const content = 'Contoh file Teradown\n';
const fixture = `<!doctype html>
<form>
  <input placeholder="Paste Terabox URL here...">
  <button type="submit">Get Download Links</button>
</form>
<section hidden>
  <button type="button" onclick="this.closest('section').hidden = true; document.querySelector('#nested').hidden = false">
    <span>Dokumen</span> <span>Explore folder</span>
  </button>
  <div class="group">
    <button aria-label="Watch contoh.txt">Preview</button>
    <button onclick="location.href = '/attachment'">Download (21 B)</button>
  </div>
  <div class="group">
    <button aria-label="Watch arsip.txt">Preview</button>
    <button onclick="document.querySelector('dialog').showModal()">Download (21 B)</button>
  </div>
  <a href="/attachment" download>Download (21 B)</a>
</section>
<section id="nested" hidden>
  <div class="group">
    <h3>Laporan.txt</h3>
    <a href="/attachment" download>Download (21 B)</a>
  </div>
</section>
<dialog><a href="/attachment">Direct Download</a></dialog>
<script>
  document.querySelector('form').addEventListener('submit', (event) => {
    event.preventDefault();
    if (event.target.querySelector('input').value === '${share}') {
      document.querySelector('section').hidden = false;
    }
  });
</script>`;

let server;
let origin;
let browser;
let scratch;

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'teradown-test-'));
  server = createServer((request, response) => {
    if (request.url === '/attachment') {
      response.writeHead(200, {
        'Content-Type': 'text/plain',
        'Content-Disposition': 'attachment; filename="contoh.txt"'
      }).end(content);
    } else {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(fixture);
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
    headless: process.env.TERADOWN_TEST_HEADED !== '1',
    env: { ...process.env, XDG_CACHE_HOME: scratch, XDG_CONFIG_HOME: scratch }
  });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

async function openResults(t) {
  const page = await browser.newPage({ acceptDownloads: true });
  t.after(() => page.close());
  page.setDefaultTimeout(5000);
  const downloads = await submitShare(page, origin, share);
  return { page, downloads };
}

test('menerima URL berbagi TeraBox HTTPS yang valid', () => {
  assert.equal(parseShareUrl(share), share);
  assert.throws(() => parseShareUrl('https://1024terabox.com.example.org/s/file'));
  assert.throws(() => parseShareUrl('http://1024terabox.com/s/file'));
  assert.throws(() => parseShareUrl('https://1024terabox.com/'));
});

test('mengisi input, mengirim formulir, dan membaca daftar hasil', async (t) => {
  const { downloads } = await openResults(t);
  assert.deepEqual(await listFiles(downloads), [
    { file: 1, name: 'contoh.txt', action: 'Download (21 B)' },
    { file: 2, name: 'arsip.txt', action: 'Download (21 B)' },
    { file: 3, name: null, action: 'Download (21 B)' }
  ]);
});

test('menangkap URL Chromium dan menyimpan isi file', async (t) => {
  const { page, downloads } = await openResults(t);
  const output = join(scratch, 'hasil.txt');
  assert.deepEqual(await getDownload(page, downloads.nth(0), { output, timeout: 5000 }), {
    url: `${origin}/attachment`,
    savedTo: output
  });
  assert.equal(await readFile(output, 'utf8'), content);
  await assert.rejects(
    getDownload(page, downloads.nth(0), { output, timeout: 5000 }),
    { code: 'EEXIST' }
  );
});

test('mengambil tautan yang ditampilkan dalam dialog', async (t) => {
  const { page, downloads } = await openResults(t);
  assert.deepEqual(await getDownload(page, downloads.nth(1), { timeout: 5000 }), {
    url: `${origin}/attachment`
  });
});

test('mengambil tautan langsung dari hasil', async (t) => {
  const { page, downloads } = await openResults(t);
  assert.deepEqual(await getDownload(page, downloads.nth(2), { timeout: 5000 }), {
    url: `${origin}/attachment`
  });
});

test('membuka folder dan mengunduh file melalui antarmuka Teradown', async (t) => {
  const calls = [];
  const fileUrl = 'https://d.terabox.app/example.txt';
  const brokenUrl = 'https://d.terabox.app/failed.txt';
  const release = Promise.withResolvers();
  const bytes = new TextEncoder().encode(content);
  t.after(() => release.resolve());
  const file = (id, name) => ({
    fs_id: id, server_filename: name, formatted_size: '21 B', direct_link: id === 4 ? brokenUrl : fileUrl
  });
  const provider = createTeraboxApi({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    fetchImpl: async (url, options) => {
      if (url.href === fileUrl) {
        assert.equal(options.headers, undefined);
        calls.push('download');
        const stream = new ReadableStream({
          async start(controller) {
            controller.enqueue(bytes.slice(0, 10));
            await release.promise;
            controller.enqueue(bytes.slice(10));
            controller.close();
          }
        });
        return new Response(stream, { headers: { 'Content-Length': String(bytes.length) } });
      }
      if (url.href === brokenUrl) return new Response(null, { status: 502 });
      assert.equal(url.href, 'https://api.teraboxdl.site/v1/api');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.method, 'POST');
      const { url: submitted, dir_path: path, page } = JSON.parse(options.body);
      assert.equal(submitted, share);
      assert.equal(page, 1);
      const expected = createHmac('sha256', 'test-secret')
        .update('POST/v1/api' + options.headers['X-Timestamp'] + options.body)
        .digest('hex');
      assert.equal(options.headers['X-Signature'], expected);
      assert.equal(options.headers['X-API-Key'], 'test-key');
      calls.push(path);
      const list = path === '/Dokumen'
        ? [file('99', 'Laporan.txt')]
        : [
          { fs_id: 2, server_filename: 'Dokumen', isdir: 1, path: '/Dokumen' },
          file(3, 'contoh.txt'), file(4, 'arsip.txt'), file(5, 'lain.txt')
        ];
      return Response.json({ errno: 0, list });
    }
  });
  const app = createTeradownServer({ provider, interactionTimeout: 5000 });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  t.after(() => page.close());
  page.setDefaultTimeout(10_000);
  const appUrl = `http://127.0.0.1:${app.address().port}/`;
  await page.goto(appUrl);
  await page.getByText('Belum ada file').waitFor();
  await page.getByRole('textbox', { name: 'Tautan berbagi TeraBox' }).fill(share);
  const apiUrl = new URL('/api/files', appUrl).href;
  await page.route(apiUrl, (route) => route.fulfill({
    status: 502,
    contentType: 'text/html',
    body: '<!doctype html><title>Bad Gateway</title>'
  }), { times: 1 });
  await page.getByRole('button', { name: 'Tampilkan file' }).click();
  await page.getByText('Server mengirim halaman di luar API (HTTP 502)', { exact: false }).waitFor();
  await page.getByRole('button', { name: 'Tampilkan file' }).click();
  await page.getByText('1 folder · 3 file', { exact: true }).waitFor();
  await page.getByRole('searchbox').fill('arsip');
  assert.equal(await page.locator('.file-row').count(), 1);
  await page.getByRole('searchbox').clear();
  await page.getByRole('button', { name: 'Buka Dokumen' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Unduh Laporan.txt' }).click();
  await page.getByText('10 B / 21 B · 47%', { exact: true }).waitFor();
  release.resolve();
  const saved = await download;
  assert.equal(saved.suggestedFilename(), 'Laporan.txt');
  assert.equal(await readFile(await saved.path(), 'utf8'), content);
  await page.getByText('Transfer selesai. Cek daftar unduhan browser.', { exact: true }).waitFor();
  assert.equal(page.url(), appUrl);
  await page.getByRole('button', { name: 'Semua file' }).click();
  await page.getByRole('button', { name: 'Unduh contoh.txt' }).waitFor();
  await page.getByRole('button', { name: 'Unduh arsip.txt' }).click();
  await page.getByText('Host file TeraBox menolak unduhan (HTTP 502).', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
  assert.deepEqual(calls, ['', '/Dokumen', 'download']);
});

test('berbagi cache permintaan dan memperbarui tautan kedaluwarsa sekali', async (t) => {
  let lookups = 0;
  const attemptedLinks = [];
  const provider = createTeraboxApi({
    apiKey: 'test-key',
    apiSecret: 'test-secret',
    fetchImpl: async (url) => {
      if (url.hostname === 'api.teraboxdl.site') {
        lookups += 1;
        await delay(30);
        return Response.json({
          errno: 0,
          list: [{
            fs_id: 1, server_filename: 'contoh.txt',
            direct_link: `https://d.terabox.app/contoh.txt?v=${lookups}`
          }]
        });
      }
      const version = url.searchParams.get('v');
      attemptedLinks.push(version);
      return version === '1' ? new Response(null, { status: 403 }) : new Response(content);
    }
  });
  const app = createTeradownServer({ provider });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const appUrl = `http://127.0.0.1:${app.address().port}`;
  const list = async () => {
    const response = await fetch(`${appUrl}/api/files`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: share })
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const [first, second] = await Promise.all([list(), list()]);
  assert.deepEqual(second, first);
  assert.deepEqual(await list(), first);
  assert.equal(lookups, 1);

  const getFile = async () => {
    const response = await fetch(appUrl + first.files[0].download);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), content);
  };
  await Promise.all([getFile(), getFile()]);
  await getFile();
  assert.equal(lookups, 2);
  assert.equal(attemptedLinks.filter((version) => version === '2').length, 3);
});

test('membatasi redirect unduhan ke host file yang didokumentasikan', async () => {
  const provider = createTeraboxApi({ fetchImpl: async (url) => {
    assert.equal(url.origin, 'https://d.terabox.app');
    return Response.redirect('https://example.org/private');
  } });
  await assert.rejects(provider.download('https://d.terabox.app/example.txt'), /host file TeraBox yang didukung/);
});
