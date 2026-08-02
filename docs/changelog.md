# Changelog

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
