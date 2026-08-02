# Changelog

## [1.1.0] — 2026-08-02

### Added
- `markPaid` atomic via `db.batch` (D1 transaction) — tidak ada orphan `claimed`, tx_id tidak hangus saat race expire
- Poll lock (45s TTL) — cron + manual + opportunistic poll tidak dobel-fetch GoBiz
- Refresh token claim atomic — hanya satu poll yang boleh konsumsi token rotating
- `CALLBACK_SECRET` — secret HMAC callback terpisah dari `API_KEY` (fallback: `API_KEY`)
- Alert callback give-up (log error saat `callback_attempts >= 5`)
- Prune otomatis: rate-limit windows, invoices/claimed > 90 hari (retention)
- QR dirender client-side dari `qris_payload` — payload tidak dikirim ke `api.qrserver.com` (field `qr_url` dihapus dari API)
- Rate limit `RETURNING count` — satu statement atomic, tanpa race check-then-act

### Changed
- Migrasi D1 pakai `wrangler d1 migrations apply` (idempotent) — `npm run db:local` / `db:remote`
- `payment_types` polling dipersempit ke `QRIS,GOPAY` (bukan kartu)
- CORS wildcard dihapus — dashboard same-origin, response API tidak lagi terbuka ke situs lain
- `.dev.vars.example` placeholder jelas + `CALLBACK_SECRET` terdokumentasi (README, deploy.md)

### Fixed
- Race `merchant_ref` duplicate create (migration `0004` partial unique index)
- `expireOld` sekarang jalan meskipun tidak ada invoice pending (prune tetap jalan)

## [1.0.0] — 2026-08-02

### Added
- QRIS static → dynamic (EMVCo TLV + CRC16, zero dependency)
- Unique amount (kode unik) anti-tabrakan antar invoice pending
- Polling mutasi GoBiz via cron `* * * * *` + opportunistic poll pada `GET /api/invoices/:id`
- Callback webhook HMAC-SHA256 (`X-Qris-Signature`)
- Auto-refresh token GoBiz (rotating, single-use) — `POST api.gobiz.co.id/goid/token`
- WebUI dashboard (Setup / Create / Invoices) dengan Basic Auth
- API key auth timing-safe (SHA-256 digest)
- Rate limiting + unique index pending amount (migration `0002`)
- Retry callback otomatis (`callback_sent`/`callback_attempts`, migration `0003`)
- Dokumentasi Docsify (GitHub Pages)

### Changed
- `run_worker_first: ["/"]` — semua request lewat worker (Basic Auth berlaku untuk dashboard)

### Fixed
- Duplikasi callback saat retry (mark `callback_sent=1` pada sukses)
- Field UI `gobiz_token` (bukan `gobiz_bearer`) — nama salah diabaikan
- Save WebUI tidak lagi mengirim field kosong (tidak me-wipe config)
