# API & Callback

## Autentikasi

Semua endpoint butuh header **API Key**, kecuali `/api/health`:

```
X-API-Key: <API_KEY>
```

Atau format Bearer:

```
Authorization: Bearer <API_KEY>
```

Verifikasi key dilakukan timing-safe (perbandingan digest SHA-256).

## Endpoint

| Method | Path | Fungsi | Auth |
|---|---|---|---|
| GET | `/api/health` | Health check | ❌ |
| POST | `/api/invoices` | Buat invoice (QRIS dinamis) | ✅ |
| GET | `/api/invoices` | List invoice (`?status=&limit=`) | ✅ |
| GET | `/api/invoices/:id` | Detail invoice (auto-trigger poll) | ✅ |
| GET | `/api/settings` | Baca konfigurasi (token dimask) | ✅ |
| PUT | `/api/settings` | Simpan konfigurasi | ✅ |
| POST | `/api/test-connection` | Probe mutasi GoBiz | ✅ |
| POST | `/api/poll` | Force polling sekarang | ✅ |

## Buat invoice

```bash
curl -s -X POST https://YOUR.workers.dev/api/invoices \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"amount":5000,"merchant_ref":"ORDER-1","expire_min":30,"callback_url":"https://your.app/hook"}'
```

| Field | Tipe | Wajib | Keterangan |
|---|---|---|---|
| `amount` | int | ✅ | Nominal IDR ≥ 1. Akan ditambah kode unik (base, base+1, …) |
| `merchant_ref` | string | – | Referensi order, max 128 karakter |
| `expire_min` | int | – | Masa berlaku menit (min 1, default 30) |
| `callback_url` | string | – | Fallback ke `default_callback` jika kosong |

Response `201`:

```json
{
  "id": "a1b2c3d4e5f60718",
  "merchant_ref": "ORDER-1",
  "amount": 5005,
  "base_amount": 5000,
  "unique_code": 5,
  "status": "pending",
  "qris_payload": "00020101021126610014COM.GO-JEK...6304F73A",
  "expires_at": "2026-08-02T04:00:00Z"
}
```

> [!NOTE]
> Tidak ada `qr_url` di response — QR dirender **lokal di client** dari `qris_payload`
> (dashboard memakai qrcode-generator via CDN). Payload QRIS tidak pernah dikirim
> ke layanan pihak ketiga manapun.

## Cek status

```bash
curl -s https://YOUR.workers.dev/api/invoices/a1b2c3d4e5f60718 -H "X-API-Key: $API_KEY"
```

Jika invoice masih `pending`, worker otomatis menjalankan satu siklus polling sebelum merespons (opportunistic poll).

## Settings

```bash
# Baca — token hanya ditampilkan sebagai boolean
curl -s https://YOUR.workers.dev/api/settings -H "X-API-Key: $API_KEY"

# Simpan — field kosong diabaikan
curl -s -X PUT https://YOUR.workers.dev/api/settings \
  -H "X-API-Key: $API_KEY" -H "Content-Type: application/json" \
  -d '{"merchant_id":"G123456789","gobiz_token":"Bearer ...","gobiz_refresh":"...","qris_static":"000201...","default_callback":"https://your.app/hook","lookback_hours":6}'
```

| Field | Keterangan |
|---|---|
| `merchant_id` | Merchant ID GoBiz |
| `gobiz_token` | Access token GoBiz (`Bearer` optional) |
| `gobiz_refresh` | Refresh token GoBiz untuk auto-refresh |
| `qris_static` | Payload QRIS static (divalidasi CRC) |
| `default_callback` | Callback default jika invoice tanpa `callback_url` |
| `lookback_hours` | Jendela polling mutasi (min 1, default 6) |

> [!WARNING]
> Nama field settings adalah `gobiz_token` — **bukan** `gobiz_bearer`. Nama yang salah akan diabaikan diam-diam.

## Callback webhook

Saat invoice lunas, worker mengirim `POST` ke `callback_url`:

**Headers:**

```
Content-Type: application/json
X-Qris-Signature: sha256=<hex>
User-Agent: qris-pg/1.0
```

**Body:**

```json
{
  "id": "a1b2c3d4e5f60718",
  "merchant_ref": "ORDER-1",
  "amount": 5005,
  "status": "paid",
  "tx_id": "tx-gopay-xxx",
  "paid_at": "2026-08-02 03:00:00",
  "unique_code": 5
}
```

### Verifikasi signature

`X-Qris-Signature` = HMAC-SHA256 dari **raw request body**, dengan secret = **API Key** worker. Contoh Node.js:

```js
const crypto = require("crypto");

function verifyQrisSignature(req, rawBody, apiKey) {
  const expected = "sha256=" + crypto
    .createHmac("sha256", apiKey)
    .update(rawBody)
    .digest("hex");
  return req.headers["x-qris-signature"] === expected;
}
```

> [!IMPORTANT]
> Selalu verifikasi signature sebelum memproses callback — ini satu-satunya bukti bahwa request benar berasal dari worker Anda.

### Retry callback

Callback yang gagal (response bukan 2xx) akan di-retry otomatis. Status tercatat di kolom `callback_sent` dan `callback_attempts` (migration `0003_callback_retry.sql`). Response poll menampilkan jumlah callback yang di-retry pada field `retried`.

## Kode error

| Kode | HTTP | Kondisi |
|---|---|---|
| `UNAUTHORIZED` | 401 | API Key salah / tidak dikirim |
| `API_KEY not set` | 503 | `API_KEY` belum di-set (secret) |
| `NOT_CONFIGURED` | 400 | merchant/token/QRIS belum dikonfigurasi |
| `INVALID_AMOUNT` | 400 | `amount` bukan integer positif |
| `INVALID_QRIS` | 400 | QRIS static gagal validasi CRC |
| `BAD_JSON` | 400 | Body bukan JSON valid |
| `NOT_FOUND` | 404 | Invoice tidak ditemukan |
| `INTERNAL` | 500 | Error tak terduga |

## Skema database

Migration: `migrations/0001_init.sql` … `0003_callback_retry.sql`

**`settings`** — key-value konfigurasi:

```sql
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

**`invoices`** — invoice QRIS:

```sql
CREATE TABLE invoices (
  id                TEXT PRIMARY KEY,
  merchant_ref      TEXT,
  amount            INTEGER NOT NULL,          -- nominal + kode unik
  base_amount       INTEGER NOT NULL,
  unique_code       INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'pending',  -- pending|paid|expired
  qris_payload      TEXT,
  callback_url      TEXT,
  expires_at        TEXT NOT NULL,
  paid_at           TEXT,
  tx_id             TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  callback_sent     INTEGER NOT NULL DEFAULT 0,
  callback_attempts INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_invoices_status_amount ON invoices(status, amount);
CREATE INDEX idx_invoices_expires      ON invoices(status, expires_at);
-- satu invoice pending per amount (anti salah-match)
CREATE UNIQUE INDEX idx_invoices_pending_amount
  ON invoices(amount) WHERE status = 'pending';
```

**`claimed`** — ledger transaksi yang sudah diklaim (idempotensi):

```sql
CREATE TABLE claimed (
  tx_id      TEXT PRIMARY KEY,
  invoice_id TEXT NOT NULL,
  amount     INTEGER NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`rate_limits`** — counter rate limiting:

```sql
CREATE TABLE rate_limits (
  key    TEXT PRIMARY KEY,
  minute INTEGER NOT NULL,
  count  INTEGER NOT NULL DEFAULT 1
);
```
