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

function downloadFile(path, name) {
  const frame = element('iframe');
  frame.hidden = true;
  frame.title = `Unduhan ${name}`;
  document.body.append(frame);
  const source = frame.contentWindow;
  const clear = () => {
    pendingDownloads.delete(source);
    clearTimeout(timer);
    frame.remove();
  };
  const timer = setTimeout(clear, 250_000);
  pendingDownloads.set(source, clear);
  frame.src = path;
  showNotice(`Unduhan ${name} diminta. Penyimpanan akan muncul di browser saat file siap.`);
}

window.addEventListener('message', (event) => {
  const clear = pendingDownloads.get(event.source);
  if (!clear || event.origin !== window.location.origin || event.data?.type !== 'teradown-download-error') return;
  clear();
  showNotice(event.data.text, 'error');
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
    element('span', 'meta', folder ? 'Folder' : entry.action.match(/\(([^)]+)\)$/)?.[1] || 'File')
  );
  const action = element('button', 'action', folder ? 'Buka' : 'Unduh');
  action.type = 'button';
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
  showState(url ? 'Mencari file…' : 'Membuka folder…', 'Sedang mengambil isi dari 1024Teradl.', 'loading');
  try {
    const request = { method: 'POST' };
    if (url) {
      request.headers = { 'Content-Type': 'application/json' };
      request.body = JSON.stringify({ url });
    }
    const response = await fetch(path, request);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Permintaan gagal.');
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
