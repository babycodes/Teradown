const form = document.querySelector('#lookup');
const input = document.querySelector('#share');
const submit = document.querySelector('#submit');
const results = document.querySelector('#results');
const count = document.querySelector('#count');
const state = document.querySelector('#state');
const search = document.querySelector('#search');
const searchWrap = document.querySelector('#search-wrap');
const breadcrumbs = document.querySelector('#breadcrumbs');
const notice = document.querySelector('#notice');
const list = document.querySelector('#list');
const downloads = document.querySelector('#downloads');

let trail = [];
let busy = false;
const pendingDownloads = new Map();

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text !== undefined) item.textContent = text;
  return item;
}

function showState(title, detail, kind = '') {
  state.querySelector('strong').textContent = title;
  state.lastElementChild.textContent = detail;
  state.dataset.kind = kind;
  state.hidden = false;
  list.hidden = true;
}

function showNotice(text, kind = '') {
  notice.dataset.kind = kind;
  notice.textContent = text;
  notice.hidden = !text;
}

function setBusy(next) {
  busy = next;
  submit.disabled = next;
  results.setAttribute('aria-busy', String(next));
  for (const button of breadcrumbs.querySelectorAll('button')) button.disabled = next;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const megabyte = 1024 * 1024;
  if (bytes < megabyte) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / megabyte).toFixed(1)} MB`;
}

function downloadFile(path, name) {
  const id = Array.from(crypto.getRandomValues(new Uint32Array(4)), (value) =>
    value.toString(16).padStart(8, '0')).join('');
  const row = element('div', 'download-status');
  const title = element('strong', null, name);
  const meter = element('progress', 'download-meter');
  meter.setAttribute('aria-label', `Progres unduhan ${name}`);
  const text = element('span', 'download-message', 'Menyiapkan unduhan…');
  text.setAttribute('role', 'status');
  const amount = element('span', 'download-amount');
  row.append(title, text, meter, amount);
  downloads.prepend(row);
  downloads.hidden = false;
  const finished = downloads.querySelectorAll('[data-finished]');
  for (const old of Array.from(finished).slice(4)) old.remove();

  const frame = element('iframe');
  frame.hidden = true;
  frame.title = `Unduhan ${name}`;
  document.body.append(frame);
  const source = frame.contentWindow;
  let timer;
  let lastResponse = Date.now();
  let done = false;
  const finish = (message, kind) => {
    if (done) return;
    done = true;
    pendingDownloads.delete(source);
    clearTimeout(timer);
    if (kind !== 'unknown') frame.remove();
    row.dataset.finished = kind;
    meter.hidden = true;
    text.textContent = message;
  };
  pendingDownloads.set(source, finish);
  const url = new URL(path, window.location.origin);
  url.searchParams.set('progress', id);
  frame.src = url.href;

  async function poll() {
    try {
      const response = await fetch(`/api/download-status/${id}`, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) throw new Error();
      const progress = await response.json();
      if (done) return;
      lastResponse = Date.now();
      if (progress.state === 'failed') {
        finish(progress.message || 'Unduhan gagal. Silakan coba lagi.', 'error');
        return;
      }
      if (progress.state !== 'preparing') {
        const knownSize = progress.total > 0;
        amount.textContent = knownSize
          ? `${formatBytes(progress.bytes)} / ${formatBytes(progress.total)} · ${Math.min(100, Math.floor(progress.bytes * 100 / progress.total))}%`
          : `${formatBytes(progress.bytes)} dikirim`;
        if (knownSize) {
          meter.max = progress.total;
          meter.value = progress.bytes;
        }
        if (text.textContent !== 'Mengirim file…') text.textContent = 'Mengirim file…';
      }
      if (progress.state === 'complete') {
        finish('Transfer selesai. Cek daftar unduhan browser.', 'complete');
        return;
      }
    } catch {
      if (Date.now() - lastResponse >= 20_000) {
        finish('Status transfer tidak tersedia. Cek daftar unduhan browser.', 'unknown');
        return;
      }
    }
    if (!done) timer = setTimeout(poll, 750);
  }
  timer = setTimeout(poll, 250);
}

window.addEventListener('message', (event) => {
  const finish = pendingDownloads.get(event.source);
  if (!finish || event.origin !== window.location.origin || event.data?.type !== 'teradown-download-error') return;
  finish(event.data.text, 'error');
});

function renderRow(entry) {
  const folder = Boolean(entry.open);
  const name = entry.name || (folder ? 'Folder' : `File ${entry.file}`);
  const row = element('article', 'file-row');
  const icon = element('div', 'file-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.append(element('span', folder ? 'folder-icon' : 'doc-icon'));
  const label = element('div', 'file-name');
  label.append(
    element('strong', null, name),
    element('span', 'meta', folder ? 'Folder' : entry.size || 'File')
  );
  const action = element('button', 'action', folder ? 'Buka' : 'Unduh');
  action.type = 'button';
  if (!folder && !entry.download) {
    action.disabled = true;
    action.textContent = 'Tidak tersedia';
  }
  action.setAttribute('aria-label', `${folder ? 'Buka' : 'Unduh'} ${name}`);
  const symbol = element('span', folder ? null : 'arrow-down', folder ? '›' : '');
  symbol.setAttribute('aria-hidden', 'true');
  action.prepend(symbol);
  action.addEventListener('click', () => {
    if (folder) void load(entry.open, undefined, name);
    else downloadFile(entry.download, name);
  });
  row.append(icon, label, action);
  return row;
}

function render() {
  const current = trail.at(-1);
  if (!current) return;
  const { files, folders } = current;
  count.textContent = folders.length ? `${folders.length} folder · ${files.length} file` : `${files.length} file`;
  searchWrap.hidden = files.length + folders.length === 0;
  breadcrumbs.hidden = trail.length < 2;
  breadcrumbs.replaceChildren();
  trail.forEach(({ name }, index) => {
    if (index > 0) breadcrumbs.append(element('span', null, '›'));
    if (index === trail.length - 1) {
      const active = element('span', null, name);
      active.setAttribute('aria-current', 'location');
      breadcrumbs.append(active);
      return;
    }
    const back = element('button', null, name);
    back.type = 'button';
    back.addEventListener('click', () => {
      trail = trail.slice(0, index + 1);
      search.value = '';
      showNotice('');
      render();
    });
    breadcrumbs.append(back);
  });

  const query = search.value.trim().toLowerCase();
  const rows = [...folders, ...files].filter(({ name, file }) =>
    (name || (file ? `File ${file}` : 'Folder')).toLowerCase().includes(query)
  );
  list.replaceChildren(...rows.map(renderRow));
  if (!rows.length) {
    showState(query ? 'Tidak ada kecocokan' : 'Folder kosong',
      query ? 'Coba cari dengan kata lain.' : 'Tidak ada file atau folder yang dapat ditampilkan.');
    return;
  }
  state.hidden = true;
  list.hidden = false;
}

async function load(path, url, name) {
  if (busy) return;
  showNotice('');
  search.value = '';
  searchWrap.hidden = true;
  if (url) {
    trail = [];
    breadcrumbs.hidden = true;
    count.textContent = 'Isi tautan yang Anda masukkan';
  }
  setBusy(true);
  showState(url ? 'Mencari file…' : 'Membuka folder…', 'Sedang mengambil isi dari TeraboxAPI.', 'loading');
  try {
    const request = { method: 'POST' };
    if (url) {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify({ url });
    }
    const response = await fetch(path, request);
    const type = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
    if (type !== 'application/json') {
      throw new Error(`Server mengirim halaman di luar API (HTTP ${response.status}). Jika memakai Cloudflare Tunnel, pastikan rute /api diteruskan ke Teradown.`);
    }
    const data = await response.json().catch(() => {
      throw new Error('Respons API Teradown rusak. Silakan coba lagi.');
    });
    if (!response.ok) throw new Error(data?.error || `Permintaan gagal (HTTP ${response.status}).`);
    if (!Array.isArray(data?.files) || !Array.isArray(data?.folders)) {
      throw new Error('Respons API Teradown tidak berisi daftar file.');
    }
    trail.push({ name, ...data });
    render();
  } catch (error) {
    if (trail.length) {
      render();
      showNotice(error.message, 'error');
    } else {
      showState('File belum dapat ditampilkan', error.message, 'error');
    }
  } finally {
    setBusy(false);
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  void load('/api/files', input.value.trim(), 'Semua file');
});
search.addEventListener('input', render);
