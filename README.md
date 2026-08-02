# qris-pg

[![version](https://img.shields.io/badge/version-1.0.0-blue)](https://jenilutfifauzi.github.io/qris-pg/)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![docs](https://img.shields.io/badge/docs-GitHub%20Pages-orange)](https://jenilutfifauzi.github.io/qris-pg/)

QRIS payment kit di **Cloudflare Workers**: static→dynamic, kode unik, poll mutasi GoBiz, callback HMAC-signed, WebUI, auto-refresh token.

> ⚠️ **Unofficial** · personal use · tidak berafiliasi dengan Gojek/GoPay/GoBiz/BI. [DISCLAIMER](DISCLAIMER.md)

---

## Fitur

- **QRIS static → dynamic** — EMVCo TLV + CRC16, tanpa dependency runtime
- **Kode unik (unique amount)** — anti tabrakan antar invoice pending
- **Polling mutasi GoBiz** — cron tiap menit, matching otomatis by amount
- **Callback webhook** — HMAC-SHA256 (`X-Qris-Signature`), retry otomatis
- **Auto-refresh token** — token GoBiz diperbarui otomatis saat expired
- **WebUI dashboard** — Setup / Create / Invoices, dilindungi Basic Auth
- **API key auth** — semua endpoint (kecuali `/api/health`) butuh `X-API-Key`

## Cara kerja

```
Create → unique amount + QR dynamic → D1 pending
Cron 1×/menit → poll mutasi → match amount → paid + callback
```

Bukan webhook Gojek — kit ini yang melakukan polling.

---

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

> 📖 Instruksi lengkap: **[Deploy](https://jenilutfifauzi.github.io/qris-pg/#/deploy)** · **[Troubleshooting](https://jenilutfifauzi.github.io/qris-pg/#/troubleshooting)**

### Ambil Bearer GoBiz

Portal → **Transaksi** → F12 Network → request `transactions` **200** → copy `Authorization: Bearer <token>`.

---

## Secrets (tidak di git)

| Apa | Di mana |
|-----|---------|
| `API_KEY` | `wrangler secret` / `.dev.vars` (gitignored) — auth API + secret HMAC callback |
| `DASH_USER` / `DASH_PASS` | `wrangler secret` — Basic Auth WebUI |
| GoBiz token, merchant, QRIS | D1 via WebUI (runtime) |

Source yang di-push **tanpa** token/password.

---

## API

Header: `X-API-Key: <API_KEY>` (kecuali `/api/health`)

```bash
# create
curl -s https://YOUR.workers.dev/api/invoices \
  -H "X-API-Key: $API_KEY" -H "content-type: application/json" \
  -d '{"amount":5000,"merchant_ref":"ORDER-1","expire_min":30,"callback_url":"https://your.app/hook"}'

# status
curl -s https://YOUR.workers.dev/api/invoices/ID -H "X-API-Key: $API_KEY"
```

Callback saat lunas: `POST` ke `callback_url` → `{ id, merchant_ref, amount, status, tx_id, paid_at, unique_code }`

Header `X-Qris-Signature: sha256=<hex>` = HMAC-SHA256(raw body, `API_KEY`) — verify di sisi penerima webhook (mis. `createHmac('sha256', process.env.QRIS_API_KEY).update(rawBody).digest('hex')`). Idempotensi: POST dengan `merchant_ref` yang masih `pending` → return invoice yang sama.

> 📖 Referensi lengkap: **[API & Callback](https://jenilutfifauzi.github.io/qris-pg/#/api)** · **[DB Schema](https://jenilutfifauzi.github.io/qris-pg/#/api?id=skema-database)**

---

## Local

```bash
cp .dev.vars.example .dev.vars   # isi API_KEY
npm run db:local && npm run dev  # localhost:8787
npm test
```
