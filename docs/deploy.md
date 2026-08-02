# Deploy

## Prasyarat

- Node.js 18+
- Akun Cloudflare (dengan Workers + D1)
- Akun merchant GoBiz (untuk Merchant ID + token)

## 1. Setup proyek

```bash
git clone https://github.com/jenilutfifauzi/qris-pg.git
cd qris-pg && npm i
npx wrangler login
```

## 2. Buat database D1

```bash
npx wrangler d1 create qris-pg
```

Output berisi `database_id` (UUID) → salin ke `wrangler.jsonc`:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "qris-pg",
    "database_id": "<UUID-DARI-ATAS>",
    "migrations_dir": "migrations"
  }
]
```

## 3. Apply migration

```bash
npm run db:remote
```

## 4. Set secrets

```bash
openssl rand -hex 24 | npx wrangler secret put API_KEY   # simpan! dipakai client + verifikasi callback
npx wrangler secret put DASH_USER
openssl rand -base64 18 | npx wrangler secret put DASH_PASS
```

| Secret | Fungsi |
|---|---|
| `API_KEY` | Auth semua endpoint API + fallback secret HMAC callback |
| `CALLBACK_SECRET` | opsional — secret HMAC callback terpisah dari `API_KEY` (`wrangler secret put CALLBACK_SECRET`) |
| `DASH_USER` | Basic Auth dashboard WebUI |
| `DASH_PASS` | Basic Auth dashboard WebUI |

## 5. Deploy

```bash
npx wrangler deploy
```

Cron `* * * * *` aktif otomatis setelah deploy.

## 6. Konfigurasi awal via WebUI

Buka `https://qris-pg.<subdomain>.workers.dev` → login Basic Auth → tab **Setup**:

1. Paste **API Key**
2. Merchant ID + GoBiz Bearer + (opsional) GoBiz Refresh Token
3. QRIS static (`000201…`) — divalidasi CRC saat disimpan
4. **Save** → **Test mutasi** (harus 200 + daftar transaksi)

## Verifikasi setelah deploy

```bash
KEY=<API_KEY>; BASE=https://qris-pg.<subdomain>.workers.dev

# 1. Health — tanpa auth
curl -s $BASE/api/health
# → {"ok":true,"service":"qris-pg","ts":"..."}

# 2. Settings — token tersimpan
curl -s $BASE/api/settings -H "X-API-Key: $KEY"
# → gobiz_token_set:true, gobiz_refresh_set:true, qris_static_set:true

# 3. Dashboard Basic Auth — tanpa kredensial harus 401
curl -s -o /dev/null -w "%{http_code}\n" $BASE/
# → 401

# 4. E2E: buat invoice → poll → status paid
curl -s -X POST $BASE/api/invoices -H "X-API-Key: $KEY" \
  -H "Content-Type: application/json" -d '{"amount":5000,"merchant_ref":"deploy-test"}'
# catat id → bayar via QRIS → 
curl -s -X POST $BASE/api/poll -H "X-API-Key: $KEY"
# → matched:1, status paid, callback_sent:1, retried:0
```

## Redeploy

```bash
npx wrangler deploy        # setelah edit source
npm run db:remote          # setelah migration baru
```

> [!NOTE]
> **Data D1 tidak ikut deploy.** Jika mengganti worker/DB, settings harus di-set ulang via WebUI atau `PUT /api/settings` — data lama tidak berpindah otomatis.

## Upgrade dari versi lama

Jika sudah punya D1 dari versi sebelumnya, cukup jalankan migration tambahan:

```bash
npm run db:remote
```

Migration idempoten (`IF NOT EXISTS`) — aman dijalankan ulang.
