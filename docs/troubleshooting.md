# Troubleshooting

## Poll response minim — `{expired, matched, pending}` saja

Poll **short-circuit**: jika tidak ada invoice pending, worker tidak pernah memanggil API GoBiz. Response tanpa field `refreshed`/`scanned`/`retried` = tidak ada invoice pending → normal.

**Solusi:** buat invoice dulu (`POST /api/invoices`), lalu poll.

## `401` dari GoBiz (token expired)

Access token GoBiz bertahan hitungan jam. Jika poll mengembalikan error auth, token perlu diperbarui.

**Jika refresh token tersimpan** (`gobiz_refresh_set: true`): worker melakukan **auto-refresh** — `POST https://api.gobiz.co.id/goid/token` dengan `grant_type: refresh_token`, menyimpan pasangan token baru, lalu retry. Poll response menampilkan `refreshed: true`.

**Jika tidak:** paste ulang token via WebUI Setup atau `PUT /api/settings` (`gobiz_token`).

> [!WARNING]
> Refresh token GoBiz bersifat **rotating / single-use** — setiap pemakaian langsung mematikan token lama. Jangan pernah "test-refresh" token yang sama dua kali, atau token akan hangus dan harus diambil ulang dari portal.

## Ambil refresh token baru dari portal

Refresh token tidak tersedia di response API biasa — ambil dari cookie portal:

1. Login `portal.gofoodmerchant.co.id`
2. DevTools → Application → Cookies → cari `refresh_token`
3. Paste ke WebUI Setup → field **GoBiz Refresh Token** → Save

Alternatif: jalankan flow login di browser dengan proxy debugger, lalu tangkap response token dari DevTools — pasangan `access_token` + `refresh_token` keluar sekaligus di response `token`.

## Rate limit `429` dari GoBiz

Endpoint GoBiz membatasi request. Jika kena `429`:

- Tunggu **±25 menit** tanpa request apa pun
- Jangan spam retry — retry malah mereset lockout

## `gobiz_token_set` tetap false setelah save

Nama field settings yang benar adalah **`gobiz_token`** — bukan `gobiz_bearer`. Field dengan nama salah diabaikan diam-diam oleh worker.

## CORS error `lens-fc.golabs.io` di console portal

Error CORS dari `lens-fc.golabs.io` di DevTools portal GoBiz adalah telemetri Faro/Grafana yang **tidak berbahaya** — bukan blocker login dan tidak terkait dengan kit ini.

## QRIS static ditolak (invalid CRC)

Worker memvalidasi checksum CRC16 (tag `6304`) saat menyimpan QRIS static. Jika ditolak:

- Pastikan payload diawali `000201`
- Pastikan disalin lengkap tanpa spasi/karakter baru
- Payload yang berupa gambar → decode dulu (pyzbar) lalu paste teksnya

## Dashboard tidak muncul (200 tanpa login)

Jika `run_worker_first` di `wrangler.jsonc` hanya `["/api/*"]`, asset dashboard disajikan platform langsung tanpa lewat worker → Basic Auth tidak berlaku. Pastikan `run_worker_first: ["/"]` lalu redeploy.

## Invoice tidak pernah jadi `paid` padahal customer sudah bayar

Cek urutan ini:

1. `GET /api/settings` — `gobiz_token_set: true`? (token expired → auto-refresh perlu refresh token)
2. `POST /api/poll` — response `matched` / `scanned` / `error`?
3. Jumlah transaksi di portal GoBiz — pastikan `lookback_hours` cukup lebar
4. Amount invoice harus **unik** — jika dua invoice pending dengan amount sama, hanya satu yang match (constraint `idx_invoices_pending_amount`)

## Callback terkirim dua kali

Sebelum migration `0003_callback_retry.sql`, callback bisa terduplikasi. Pastikan migration terbaru sudah di-apply (`npm run db:remote`) dan kolom `callback_sent` terisi 1 pada invoice yang sudah sukses callback.
