# qris-pg — API & Callback

## Autentikasi

Header `X-API-Key: <API_KEY>` di semua request, kecuali `/api/health`.

```bash
curl -s https://YOUR.workers.dev/api/health
# {"ok":true,"service":"qris-pg","ts":"..."}
```

## Create invoice

```bash
curl -s -X POST https://YOUR.workers.dev/api/invoices \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"amount":5000,"merchant_ref":"ORDER-1","expire_min":30,"callback_url":"https://your.app/hook"}'
```

| Field | Tipe | Wajib | Catatan |
|---|---|---|---|
| `amount` | int | ✅ | IDR, >= 1. Ditambah kode unik (base, base+1, …) |
| `merchant_ref` | string | - | max 128 char |
| `expire_min` | int | - | default 30 |
| `callback_url` | string | - | fallback ke `default_callback` |

Response `201`:

```json
{
  "id": "abc123def4567890",
  "merchant_ref": "ORDER-1",
  "amount": 5005,
  "base_amount": 5000,
  "unique_code": 5,
  "status": "pending",
  "qris_payload": "00020101021126610014COM.GO-JEK...6304XXXX",
  "qr_url": "https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=...",
  "expires_at": "2026-08-02T04:00:00Z"
}
```

## Cek status

```bash
curl -s https://YOUR.workers.dev/api/invoices/abc123def4567890 -H "X-API-Key: $API_KEY"
```

Invoice pending → worker otomatis trigger poll (opportunistic) sebelum balas.

## List invoice

```bash
curl -s "https://YOUR.workers.dev/api/invoices?status=paid&limit=20" -H "X-API-Key: $API_KEY"
```

## Settings

```bash
# baca (token cuma ditampilkan sebagai boolean)
curl -s https://YOUR.workers.dev/api/settings -H "X-API-Key: $API_KEY"

# simpan — field kosong diabaikan
curl -s -X PUT https://YOUR.workers.dev/api/settings \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"merchant_id":"G123456789","gobiz_token":"Bearer ...","gobiz_refresh":"...","qris_static":"000201...","default_callback":"https://your.app/hook","lookback_hours":6}'
```

⚠️ Field settings adalah `gobiz_token` (bukan `gobiz_bearer`).

## Callback webhook

Saat lunas, worker `POST` ke `callback_url` dengan header:

```
X-Qris-Signature: sha256=<hex>
```

Signature = HMAC-SHA256(raw request body, secret = API_KEY). Verifikasi:

```js
const crypto = require("crypto");
const expected = "sha256=" + crypto.createHmac("sha256", API_KEY).update(rawBody).digest("hex");
if (req.headers["x-qris-signature"] !== expected) return 401;
```

Body:

```json
{
  "id": "abc123def4567890",
  "merchant_ref": "ORDER-1",
  "amount": 5005,
  "status": "paid",
  "tx_id": "tx-gopay-xxx",
  "paid_at": "2026-08-02 03:00:00",
  "unique_code": 5
}
```

Callback dikirim sekali; yang gagal akan diretry (cek `retried` di response poll).
