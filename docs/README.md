# qris-pg

Unofficial **QRIS payment kit** untuk Cloudflare Workers: static→dynamic QRIS, kode unik, polling mutasi GoBiz, callback HMAC-signed, WebUI, dan auto-refresh token.

> ⚠️ Unofficial · personal use · tidak afiliasi dengan Gojek/GoPay/GoBiz/BI. Bisa berubah/putus tanpa pemberitahuan.

## Fitur

- QRIS static → **dynamic** (EMVCo TLV + CRC16, zero deps)
- Kode unik (unique amount) anti tabrakan antar invoice
- Poll mutasi GoBiz tiap menit (cron `* * * * *`)
- Callback webhook **HMAC-SHA256** (`X-Qris-Signature`)
- **Auto-refresh token** GoBiz (rotating, single-use)
- WebUI dashboard (Setup / Create / Invoices) + Basic Auth
- Semua endpoint API dilindungi `X-API-Key`

## Arsitektur

```
Create → unique amount + QR dynamic → D1 pending
Cron 1×/menit → poll mutasi GoBiz → match amount → paid + callback
```

Stack: Cloudflare Worker (`src/index.js`) + D1 (`src/db.js`) + Assets (`public/`).

## Quickstart

Butuh: Node 18+, akun Cloudflare, merchant GoBiz.

```bash
git clone https://github.com/jenilutfifauzi/qris-pg.git
cd qris-pg && npm i && npx wrangler login

npx wrangler d1 create qris-pg
# salin database_id → wrangler.jsonc

npm run db:remote
openssl rand -hex 24 | npx wrangler secret put API_KEY   # simpan key-nya
npx wrangler secret put DASH_USER
npx wrangler secret put DASH_PASS
npx wrangler deploy
```

Buka `https://qris-pg.<subdomain>.workers.dev` → **Setup**:
1. Paste **API Key**
2. Merchant ID + GoBiz Bearer + QRIS static (`000201…`)
3. **Save** → **Test mutasi**

### Ambil Bearer GoBiz

Portal → **Transaksi** → F12 Network → request `transactions` **200** → copy `Authorization: Bearer ***`.

## API

Semua endpoint (kecuali `/api/health`) butuh header `X-API-Key: <API_KEY>`.

### Create invoice

```bash
curl -s -X POST https://YOUR.workers.dev/api/invoices \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"amount":5000,"merchant_ref":"ORDER-1","expire_min":30,"callback_url":"https://your.app/hook"}'
```

Response 201: `{ id, amount, unique_code, status, qris_payload, qr_url, expires_at, ... }`

### Cek status

```bash
curl -s https://YOUR.workers.dev/api/invoices/ID -H "X-API-Key: $API_KEY"
```

### Endpoint lain

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/settings` | baca config (token dimasked) |
| PUT | `/api/settings` | simpan merchant / token / QRIS / callback |
| POST | `/api/test-connection` | probe mutasi GoBiz |
| POST | `/api/poll` | force poll sekarang |
| GET | `/api/health` | health check (tanpa auth) |
| GET | `/api/invoices?status=&limit=` | list invoice |

## Callback

Saat invoice lunas, worker `POST` ke `callback_url`:

```json
{
  "id": "abc123",
  "merchant_ref": "ORDER-1",
  "amount": 5000,
  "status": "paid",
  "tx_id": "tx-gopay-xxx",
  "paid_at": "2026-08-02 03:00:00",
  "unique_code": 0
}
```

Header verifikasi: `X-Qris-Signature: sha256=<hex>` = HMAC-SHA256(raw body, secret = API_KEY). Selalu verifikasi signature sebelum proses webhook.

## Auto-refresh token

Poll detect 401 → `POST https://api.gobiz.co.id/goid/token` (grant_type=refresh_token, client_id=go-biz-web-new) → simpan pasangan token baru → retry sekali.

- Refresh token **rotating single-use** — jangan pernah test-refresh token yang sama 2×.
- Sumber refresh token: cookie `refresh_token` di `portal.gofoodmerchant.co.id` (DevTools → Application → Cookies), bukan dari response API.
- Butuh header device `X-PhoneMake`/`X-PhoneModel` — sudah di-set default di `src/gobiz.js`.

## Development lokal

```bash
cp .dev.vars.example .dev.vars   # isi API_KEY
npm run db:local && npm run dev  # localhost:8787
npm test                          # 8 test
```

## Security

- API key dicek timing-safe (SHA-256 digest)
- Dashboard Basic Auth (`DASH_USER`/`DASH_PASS` via `wrangler secret put`)
- Callback HMAC-signed
- `run_worker_first: ["/"]` — semua request lewat worker dulu
- Jangan commit `.dev.vars`, token, atau payload QRIS produksi

## Disclaimer

Bukan webhook resmi Gojek — kita yang poll. Gunakan untuk personal/eduksi; untuk payment produksi regulasi, pakai acquirer resmi.
