# Disclaimer

Dokumen ini menjelaskan status hukum, risiko, dan batasan penggunaan **qris-pg** secara transparan. Baca sebelum menggunakan, menyalin, atau menyebarkan proyek ini.

## Status proyek

- **Unofficial** — proyek ini **bukan** produk resmi dari Gojek, GoPay, GoBiz, GoTo Group, Bank Indonesia, atau penyedia jasa pembayaran mana pun.
- Dibuat untuk **penggunaan pribadi dan edukasi**, bukan untuk dipakai sebagai pemroses pembayaran produksi yang diatur regulasi.
- Tidak ada afiliasi, dukungan, atau sponsor dari pihak mana pun yang disebutkan di atas.

## Cara kerja teknis (yang perlu Anda pahami)

qris-pg bekerja dengan cara:

1. Menerima request `POST /api/invoices` dan menghasilkan **QRIS dinamis** dari QRIS statis merchant.
2. Menambahkan **kode unik** pada nominal agar setiap invoice pending dapat dibedakan.
3. **Polling mutasi** ke portal merchant GoBiz (cron tiap menit) — bukan menerima webhook resmi.
4. Mengirim **callback HMAC-signed** ke URL Anda saat pembayaran terdeteksi.
5. **Auto-refresh token** GoBiz menggunakan refresh token yang bersifat rotating/single-use.

## Risiko yang Anda tanggung

### API portal merchant (reverse-engineered)

- Kit ini mengakses API portal merchant yang **tidak terdokumentasi secara publik** dan bersifat reverse-engineered.
- API tersebut dapat **berubah, dibatasi, atau diputus tanpa pemberitahuan** kapan pun oleh pihak platform.
- Perubahan dapat menyebabkan fitur rusak, token invalid, atau data tidak sinkron. **Tidak ada jaminan perbaikan.**

### Bukan webhook resmi — kemungkinan transaksi terlewat

- Karena berbasis polling (bukan webhook), transaksi bisa **terlewat** jika: token expired tanpa refresh token tersedia, terjadi rate limit (`429`), jendela `lookback_hours` terlalu pendek, atau worker tidak berjalan.
- Jika transaksi terlewat, invoice tetap `pending` dan **dana tidak otomatis diverifikasi** — verifikasi manual mungkin diperlukan.

### Ketergantungan pihak ketiga

- Render gambar QR menggunakan **api.qrserver.com** (layanan gratis goQR.me). Jika layanan ini down atau rate-limited, URL QR bisa gagal dimuat (payload QRIS tetap bisa dihasilkan lokal dari `qris_payload`).
- Hanya payload QRIS (bukan kredensial) yang dikirim ke layanan tersebut.

### Keamanan & kredensial

- **Anda bertanggung jawab penuh** atas keamanan `API_KEY`, `DASH_USER`/`DASH_PASS`, token GoBiz, dan refresh token. Jangan commit ke repo publik, jangan bagikan, jangan simpan di log.
- Refresh token GoBiz bersifat **rotating/single-use** — salah pakai (misal diuji berulang) akan membuat token hangus dan harus diambil ulang dari portal.

## Batasan hukum & lisensi

- **Tanpa jaminan** (provided "as is", tanpa warranty dalam bentuk apa pun).
- **Gunakan dengan risiko Anda sendiri** — pengembang tidak bertanggung jawab atas kerugian langsung/tidak langsung, termasuk dana hilang, data bocor, atau akun diblokir.
- **Jangan gunakan untuk pemrosesan pembayaran berskala/regulasi** tanpa lisensi resmi dan perjanjian acquirer yang sah.
- **Anda bertanggung jawab** atas kepatuhan terhadap hukum setempat, Terms of Service platform, dan kewajiban perpajakan.
- Proyek ini **tidak disertai lisensi pengguna akhir** (baca: tidak ada file LICENSE) — penggunaan, penyalinan, dan distribusi dilakukan atas kebijaksanaan Anda dan bukan rekomendasi pengembang.

## Akhir kata

Jika Anda butuh pemrosesan pembayaran yang andal dan sesuai regulasi, gunakan **penyedia jasa pembayaran resmi** (acquirer/PSP berlisensi). Proyek ini ada untuk belajar dan eksperimen — bukan pengganti infrastruktur pembayaran produksi.

---

*Disclaimer ini dapat diperbarui tanpa pemberitahuan. Versi terbaru selalu tersedia di repositori ini.*
