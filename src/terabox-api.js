import { createHmac } from 'node:crypto';

const endpoint = new URL('https://api.teraboxdl.site/v1/api');
const redirectStatuses = new Set([301, 302, 303, 307, 308]);

export class TeraboxApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

export class ExpiredDownloadLinkError extends TeraboxApiError {}

function fileUrl(value) {
  const url = typeof value === 'string' ? URL.parse(value) : null;
  if (!url || url.origin !== 'https://d.terabox.app' || url.username || url.password) {
    throw new TeraboxApiError('TeraboxAPI belum memberikan tautan unduhan dari host file TeraBox yang didukung.');
  }
  return url;
}

export function createTeraboxApi({
  apiKey = process.env.TERABOX_API_KEY,
  apiSecret = process.env.TERABOX_API_SECRET,
  fetchImpl = fetch
} = {}) {
  async function list(shareUrl, dirPath, signal) {
    if (!apiKey?.trim() || !apiSecret?.trim()) {
      throw new TeraboxApiError('Server belum memiliki TERABOX_API_KEY dan TERABOX_API_SECRET.', 503);
    }
    const body = JSON.stringify({ url: shareUrl, dir_path: dirPath, page: 1 });
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const signature = createHmac('sha256', apiSecret)
      .update(`POST${endpoint.pathname}${timestamp}${body}`)
      .digest('hex');

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': apiKey,
          'X-Timestamp': timestamp,
          'X-Signature': signature
        },
        redirect: 'manual',
        body,
        signal
      });
    } catch {
      signal?.throwIfAborted();
      throw new TeraboxApiError('Server Teradown tidak dapat terhubung ke TeraboxAPI.');
    }
    if (!response.ok) {
      await response.body?.cancel();
      if ([401, 403].includes(response.status)) {
        throw new TeraboxApiError(`TeraboxAPI menolak autentikasi (HTTP ${response.status}). Periksa key, secret, dan jam server.`);
      }
      if (response.status === 429) {
        throw new TeraboxApiError('Batas permintaan TeraboxAPI tercapai. Coba lagi sebentar.', 429);
      }
      throw new TeraboxApiError(`TeraboxAPI mengembalikan HTTP ${response.status}.`);
    }

    const data = await response.json().catch(() => null);
    if (!data || !Number.isInteger(data.errno)) {
      throw new TeraboxApiError('TeraboxAPI mengirim respons yang tidak valid.');
    }
    if (data.errno !== 0) {
      throw new TeraboxApiError(`TeraboxAPI gagal membaca tautan (kode ${data.errno}).`);
    }
    if (!Array.isArray(data.list)) {
      throw new TeraboxApiError('Respons TeraboxAPI tidak berisi daftar file.');
    }
    return data.list;
  }

  async function download(url, signal) {
    let current = fileUrl(url);
    for (let redirects = 0; redirects <= 3; redirects += 1) {
      let response;
      try {
        response = await fetchImpl(current, { redirect: 'manual', signal });
      } catch {
        throw new TeraboxApiError('Server Teradown tidak dapat terhubung ke host file TeraBox.');
      }
      if (redirectStatuses.has(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        current = fileUrl(location && URL.parse(location, current)?.href);
        continue;
      }
      if (response.status === 200 && response.body) return response;
      await response.body?.cancel();
      const message = `Host file TeraBox menolak unduhan (HTTP ${response.status}).`;
      if ([401, 403, 410].includes(response.status)) {
        throw new ExpiredDownloadLinkError(message);
      }
      throw new TeraboxApiError(message);
    }
    throw new TeraboxApiError('Host file TeraBox mengirim terlalu banyak pengalihan.');
  }

  return { list, download };
}
