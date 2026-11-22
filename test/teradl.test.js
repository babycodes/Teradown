import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { getDownload, listFiles, parseShareUrl, submitShare } from '../src/teradl.js';
import { createTeradownServer } from '../src/web.js';

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
  const app = createTeradownServer({ siteUrl: origin, interactionTimeout: 5000 });
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => app.close(resolve)));
  const page = await browser.newPage({ acceptDownloads: true, viewport: { width: 390, height: 844 } });
  t.after(() => page.close());
  page.setDefaultTimeout(10_000);
  const appUrl = `http://127.0.0.1:${app.address().port}/`;
  await page.goto(appUrl);
  await page.getByText('Belum ada file').waitFor();
  await page.getByRole('textbox', { name: 'Tautan berbagi TeraBox' }).fill(share);
  await page.getByRole('button', { name: 'Tampilkan file' }).click();
  await page.getByText('1 folder · 3 file', { exact: true }).waitFor();
  await page.getByRole('searchbox').fill('arsip');
  assert.equal(await page.locator('.file-row').count(), 1);
  await page.getByRole('searchbox').clear();
  await page.getByRole('button', { name: 'Buka Dokumen' }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Unduh Laporan.txt' }).click();
  const file = await download;
  assert.equal(file.suggestedFilename(), 'Laporan.txt');
  assert.equal(await readFile(await file.path(), 'utf8'), content);
  assert.equal(page.url(), appUrl);
  await page.getByRole('button', { name: 'Semua file' }).click();
  await page.getByRole('button', { name: 'Unduh contoh.txt' }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
});
