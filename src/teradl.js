import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const shareHosts = new Set(['1024terabox.com', 'terabox.com', 'teraboxapp.com']);
const fileDownloadName = /^Download\s*\([^)]+\)$/i;
const submitName = /^(?:[⚡⬇↓]\s*)?(?:Download(?: Now| File)?|Get (?:Download )?Links?|Get Files?|Generate (?:Download )?Links?|Fetch (?:Download )?Links?|Submit)$/i;

export function parseShareUrl(value) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.port ||
      !shareHosts.has(url.hostname.replace(/^www\./, '')) ||
      !/^\/s\/[\w-]+\/?$/.test(url.pathname)) {
    throw new Error('Gunakan URL berbagi HTTPS TeraBox dengan format /s/<id>.');
  }
  return url.href;
}

function resultDownloads(page) {
  return page.getByRole('button', { name: fileDownloadName })
    .or(page.getByRole('link', { name: fileDownloadName })).filter({ visible: true });
}

function folderButtons(page) {
  return page.getByRole('button', { name: /Explore folder$/i }).filter({ visible: true });
}

export async function listFolders(page) {
  return folderButtons(page).evaluateAll((elements) => elements.map((element) =>
    element.textContent.trim().replace(/Explore folder$/i, '').trim()
  ));
}

export async function enterFolder(page, folder) {
  const folders = folderButtons(page);
  if ((await listFolders(page))[folder.index] !== folder.name) {
    throw new Error('Daftar folder berubah. Tampilkan ulang tautannya.');
  }
  const previous = folders.nth(folder.index);
  const original = await previous.elementHandle();
  try {
    await previous.click();
    await original.waitForElementState('hidden');
  } finally {
    await original.dispose();
  }
  const downloads = resultDownloads(page);
  await downloads.or(folderButtons(page)).first().waitFor({ state: 'visible' });
  return downloads;
}

export async function submitShare(page, siteUrl, shareUrl) {
  const response = await page.goto(siteUrl, { waitUntil: 'domcontentloaded' });
  if (response && response.status() >= 400 && ![403, 429, 503].includes(response.status())) {
    throw new Error(`Halaman 1024Teradl merespons dengan HTTP ${response.status()}.`);
  }
  const input = page.getByPlaceholder('Paste Terabox URL here...', { exact: true })
    .filter({ visible: true });
  await input.fill(shareUrl);

  const form = input.locator('xpath=ancestor::form[1]');
  const formSubmit = form.locator('button:not([type]), button[type=submit], input[type=submit]')
    .filter({ visible: true });
  if (await formSubmit.count() === 1) {
    await formSubmit.click();
  } else {
    await page.getByRole('button', { name: submitName }).filter({ visible: true }).click();
  }

  const downloads = resultDownloads(page);
  await downloads.or(folderButtons(page)).first().waitFor({ state: 'visible' });
  return downloads;
}

export async function listFiles(downloads) {
  return downloads.evaluateAll((elements) => elements.map((element, index) => {
    const card = element.closest('div.group');
    const watch = card?.querySelector('button[aria-label^="Watch "]');
    return {
      file: index + 1,
      name: watch?.getAttribute('aria-label')?.slice('Watch '.length)
        ?? card?.querySelector('h3')?.textContent.trim() ?? null,
      action: element.textContent.trim()
    };
  }));
}

function httpUrl(value, baseUrl) {
  const url = new URL(value, baseUrl);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Tombol unduhan tidak memberikan URL HTTP(S) yang dapat digunakan.');
  }
  return url.href;
}

export async function getDownload(page, button, { output, timeout }) {
  const result = await resolveDownloadAction(page, button, { timeout, file: Boolean(output) });
  if (result.url) return result;
  const { download } = result;
  const url = httpUrl(download.url());
  if (!output) return { url };

  const savedTo = resolve(output);
  await copyFile(await download.path(), savedTo, constants.COPYFILE_EXCL);
  return { url, savedTo };
}

export async function startBrowserDownload(page, button, timeout) {
  const { download } = await resolveDownloadAction(page, button, { timeout, file: true });
  return download;
}

async function resolveDownloadAction(page, button, { timeout, file }) {
  const baseUrl = page.url();
  const href = await button.getAttribute('href');
  if (href && !href.startsWith('#') && !file) {
    return { url: httpUrl(href, baseUrl) };
  }

  const context = page.context();
  const listeners = new Map();
  let resolveDownload;
  const browserDownload = new Promise((resolve) => { resolveDownload = resolve; });
  const watchPage = (tab) => {
    const listener = (download) => resolveDownload({ download });
    tab.on('download', listener);
    listeners.set(tab, listener);
  };
  watchPage(page);
  context.on('page', watchPage);
  // Some results expose a second Download link in a dialog.
  const dialogLink = page.getByRole('dialog').getByRole('link', {
    name: /^(?:(?:Direct |Start )?Download(?: Now)?|Download\s*\([^)]+\))$/i
  }).filter({ visible: true });

  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(
      'Tidak ada URL atau unduhan dari tombol yang dipilih. Periksa dialog atau verifikasi di browser.'
    )), timeout);
  });
  try {
    const dialog = dialogLink.getAttribute('href', { timeout }).then((url) => {
      if (url && !url.startsWith('#')) return { url: httpUrl(url, baseUrl) };
      return browserDownload;
    });
    const result = await Promise.race([
      Promise.all([button.click({ timeout }), Promise.race([browserDownload, dialog])])
        .then(([, result]) => result),
      deadline
    ]);
    if (result.download || !file) return result;

    const [downloadResult] = await Promise.race([
      Promise.all([browserDownload, dialogLink.click({ timeout })]),
      deadline
    ]);
    return downloadResult;
  } finally {
    clearTimeout(timer);
    context.off('page', watchPage);
    for (const [tab, listener] of listeners) tab.off('download', listener);
  }
}
