# Teradown

Aplikasi web dan CLI Node.js yang menggunakan Chromium dan formulir publik 1024Teradl untuk menampilkan file dari tautan berbagi TeraBox. Gunakan tautan yang Anda miliki atau diizinkan untuk diunduh. URL berbagi dikirim ke 1024Teradl saat formulir diisi dan dikirim.

## Menjalankan

Pasang Node.js 22 atau lebih baru serta Chromium atau Google Chrome. Pada Linux, CLI mencari `/usr/bin/chromium`; gunakan `CHROMIUM_PATH` jika browser terpasang di lokasi lain.

```sh
npm ci
npm test
```

### Web

```sh
npm run web
```

Buka `http://127.0.0.1:9876` di mesin yang menjalankan server. Atur `HOST` atau `PORT` jika perlu. Tempel tautan dan klik **Tampilkan file**. Daftar mendukung pencarian, navigasi folder, dan tombol **Unduh**. Browser menerima file dari server Teradown melalui halaman yang sama. Server menggunakan Chromium headless. Jika 1024Teradl meminta verifikasi manusia, gunakan CLI berjendela.

Untuk Cloudflare Tunnel, atur **Service URL** ke `http://127.0.0.1:9876`. Jalankan Teradown dan `cloudflared` pada mesin dan namespace jaringan yang sama agar connector dapat mencapai alamat loopback. Dari lingkungan tempat connector berjalan, periksa origin dengan `curl -fsS http://127.0.0.1:9876/`.

`npm run web` membaca file `.env` di root proyek jika tersedia. Simpan konfigurasi lokal TeraboxAPI sebagai `TERABOX_API_KEY=`. Integrasi TeraboxAPI masih memerlukan kontrak endpoint yang terdokumentasi.

### CLI

Setel `URL_TERA` ke URL berbagi HTTPS milik Anda, lalu jalankan:

```sh
npm start -- "$URL_TERA"
npm start -- "$URL_TERA" --file 1
npm start -- "$URL_TERA" --file 1 --output ./contoh.bin
```

Perintah pertama mencetak daftar JSON tombol unduhan pada tampilan hasil. Nomor `--file` mengikuti urutan yang tampil. Perintah kedua mencetak URL yang diberikan oleh 1024Teradl atau yang dipakai Chromium saat memulai unduhan. Jika URL bergantung pada sesi atau kedaluwarsa, gunakan `--output` untuk menyimpan file melalui sesi browser yang sama. Path tujuan harus baru dan direktori induknya harus sudah ada.

Secara default Chromium membuka jendela. Saat verifikasi manusia muncul, selesaikan di jendela sebelum waktu tunggu habis. Gunakan `--timeout 180` untuk memperpanjang waktu tunggu per interaksi, atau `--headless` untuk menjalankan Chromium tanpa tampilan pada halaman yang bisa diakses tanpa verifikasi. Tidak diperlukan akun TeraBox untuk alur yang dilayani formulir publik tersebut.

## Codex Cloud

Jalankan perintah dari `/workspace/Teradown`. Gunakan `npm --cache /tmp/teradown-npm ci` jika direktori cache bawaan tidak dapat ditulis. `npm test` menjalankan Chromium pada server HTTP lokal untuk menguji formulir, daftar file, ekstraksi URL, dan unduhan tanpa menghubungi layanan publik. Pengujian live memerlukan izin koneksi HTTPS ke `1024teradl.com` serta ke host unduhan yang diberikan layanan jika browser perlu mengambil file. Mode berjendela memerlukan sesi desktop yang aktif dan variabel `DISPLAY` yang menunjuk ke sesi tersebut.

Pada desktop yang aktif, jalankan `TERADOWN_TEST_HEADED=1 npm test` untuk mengulang pengujian dengan jendela Chromium.
