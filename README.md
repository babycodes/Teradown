# Teradown

Aplikasi web Node.js untuk melihat dan mengunduh file dari tautan berbagi TeraBox. Web mengirim tautan yang dimasukkan ke TeraboxAPI. Gunakan tautan yang Anda miliki atau diizinkan untuk diunduh.

## Menjalankan

Pasang Node.js 22 atau lebih baru. CLI dan tes browser juga memerlukan Chromium atau Google Chrome. Pada Linux, gunakan `CHROMIUM_PATH` jika browser terpasang di luar `/usr/bin/chromium`.

```sh
npm ci
npm test
```

### Web

Buat file `.env` di root proyek dan isi kedua variabel dengan key dan secret TeraboxAPI.

```dotenv
TERABOX_API_KEY=
TERABOX_API_SECRET=
```

```sh
npm run web
```

Buka `http://127.0.0.1:9876` di mesin yang menjalankan server. Atur `HOST` atau `PORT` jika perlu. Tempel tautan dan klik **Tampilkan file**. Server menandatangani permintaan ke `api.teraboxdl.site` dan meneruskan file dari `d.terabox.app` ke browser. Daftar mengambil halaman pertama per folder. Tombol **Unduh** tersedia untuk file dengan `direct_link`.

Untuk Cloudflare Tunnel, atur **Service URL** ke `http://127.0.0.1:9876`. Jalankan Teradown dan `cloudflared` pada mesin dan namespace jaringan yang sama agar connector dapat mencapai alamat loopback. Dari lingkungan tempat connector berjalan, periksa origin dengan `curl -fsS http://127.0.0.1:9876/`.

### CLI

CLI menggunakan Chromium dan formulir publik 1024Teradl. Setel `URL_TERA` ke URL berbagi HTTPS milik Anda, lalu jalankan:

```sh
npm start -- "$URL_TERA"
npm start -- "$URL_TERA" --file 1
npm start -- "$URL_TERA" --file 1 --output ./contoh.bin
```

Perintah pertama mencetak daftar JSON tombol unduhan pada tampilan hasil. Nomor `--file` mengikuti urutan yang tampil. Perintah kedua mencetak URL yang diberikan oleh 1024Teradl atau yang dipakai Chromium saat memulai unduhan. Jika URL bergantung pada sesi atau kedaluwarsa, gunakan `--output` untuk menyimpan file melalui sesi browser yang sama. Path tujuan harus baru dan direktori induknya harus sudah ada.

Secara default Chromium membuka jendela. Saat verifikasi manusia muncul, selesaikan di jendela sebelum waktu tunggu habis. Gunakan `--timeout 180` untuk memperpanjang waktu tunggu per interaksi, atau `--headless` untuk menjalankan Chromium tanpa tampilan pada halaman yang bisa diakses tanpa verifikasi. Tidak diperlukan akun TeraBox untuk alur yang dilayani formulir publik tersebut.

## Codex Cloud

Jalankan perintah dari `/workspace/Teradown`. Gunakan `npm --cache /tmp/teradown-npm ci` jika direktori cache bawaan tidak dapat ditulis. `npm test` menguji API dan unduhan dengan respons contoh lokal. Untuk menggunakan proxy Cloud dengan Node.js 24, jalankan `NODE_USE_ENV_PROXY=1 npm run web`. Pengujian web dengan layanan asli memerlukan izin HTTPS ke `api.teraboxdl.site` dan `d.terabox.app`. Mode CLI berjendela memerlukan sesi desktop aktif dan variabel `DISPLAY`.

Pada desktop yang aktif, jalankan `TERADOWN_TEST_HEADED=1 npm test` untuk mengulang pengujian dengan jendela Chromium.
