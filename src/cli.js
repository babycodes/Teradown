import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium, errors } from 'playwright-core';
import { getDownload, listFiles, parseShareUrl, submitShare } from './teradl.js';

const usage = `Penggunaan:
  npm start -- <URL_TeraBox>
  npm start -- <URL_TeraBox> --file 1 [--output ./contoh.zip]

  --file <nomor>    Ambil URL unduhan untuk satu file dari daftar.
  --output <path>   Simpan file ke path baru. Hanya berlaku bersama --file.
  --headless        Jalankan Chromium tanpa jendela.
  --timeout <detik> Waktu tunggu per interaksi (default 90).
  CHROMIUM_PATH     Lokasi Chromium/Chrome (default /usr/bin/chromium).
`;

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      file: { type: 'string' },
      output: { type: 'string' },
      headless: { type: 'boolean', default: false },
      timeout: { type: 'string', default: '90' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log(usage);
    return;
  }
  if (positionals.length !== 1) throw new Error(usage);

  const shareUrl = parseShareUrl(positionals[0]);
  const file = Number(values.file);
  if (values.file !== undefined && (!Number.isSafeInteger(file) || file < 1)) {
    throw new Error('--file harus berupa nomor bulat mulai dari 1.');
  }
  if (values.output !== undefined && (!values.output || !file)) {
    throw new Error('--output memerlukan path dan pilihan --file.');
  }
  const seconds = Number(values.timeout);
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3600) {
    throw new Error('--timeout harus berupa jumlah detik antara 1 dan 3600.');
  }
  const timeout = seconds * 1000;
  if (!values.headless && process.platform === 'linux' && !process.env.DISPLAY) {
    throw new Error('Mode berjendela memerlukan sesi desktop Linux. Gunakan --headless untuk halaman yang tidak meminta verifikasi.');
  }

  const browserDir = await mkdtemp(join(tmpdir(), 'teradown-'));
  try {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: values.headless,
      env: {
        ...process.env,
        XDG_CACHE_HOME: join(browserDir, 'cache'),
        XDG_CONFIG_HOME: join(browserDir, 'config')
      }
    });
    try {
      const page = await browser.newPage({ acceptDownloads: true });
      page.setDefaultTimeout(timeout);
      if (!values.headless) {
        console.error('Jika verifikasi manusia muncul, selesaikan di jendela Chromium.');
      }
      const downloads = await submitShare(page, 'https://1024teradl.com/', shareUrl);
      const files = await listFiles(downloads);
      if (!file) {
        console.log(JSON.stringify(files, null, 2));
        return;
      }
      const selected = files[file - 1];
      if (!selected) throw new Error(`Nomor file harus antara 1 dan ${files.length}.`);

      const result = await getDownload(page, downloads.nth(file - 1), {
        output: values.output,
        timeout
      });
      console.log(JSON.stringify({ ...selected, ...result }, null, 2));
    } finally {
      await browser.close();
    }
  } finally {
    await rm(browserDir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof errors.TimeoutError) {
    console.error('Elemen 1024Teradl tidak muncul sebelum waktu tunggu habis. Periksa verifikasi atau tampilan halaman di mode berjendela.');
  } else {
    console.error(error.message);
  }
  process.exitCode = 1;
}
