# qris-pg

QRIS payment kit di **Cloudflare Workers**: static→dynamic, kode unik, poll mutasi GoBiz, callback, WebUI.

> Unofficial · personal use · [DISCLAIMER](DISCLAIMER.md)

---

## Quickstart

Butuh: Node 18+, akun Cloudflare, merchant GoBiz.

```bash
git clone https://github.com/jeyyprtf/qris-pg.git
cd qris-pg && npm i && npx wrangler login

npx wrangler d1 create qris-pg
# salin database_id → wrangler.jsonc

npm run db:remote
openssl rand -hex 24 | npx wrangler secret put API_KEY   # simpan key-nya
npx wrangler deploy
```

Buka `https://qris-pg.<subdomain>.workers.dev` → **Setup**:

1. Paste **API Key**
2. Merchant ID + GoBiz Bearer + QRIS static (`000201…`)
3. **Save** → **Test mutasi**

### Ambil Bearer GoBiz

Portal → **Transaksi** → F12 Network → `transactions` **200** → copy `Authorization: Bearer …`

Token mati? Paste ulang di Setup.

---

## Secrets (tidak di git)

| Apa | Di mana |
|-----|---------|
| `API_KEY` | `wrangler secret` / `.dev.vars` (gitignored) |
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

---

## Local

```bash
cp .dev.vars.example .dev.vars   # isi API_KEY
npm run db:local && npm run dev  # localhost:8787
npm test
```

---

## Cara kerja

```
Create → unique amount + QR dynamic → D1 pending
Cron 1×/menit → poll mutasi → match amount → paid + callback
```

Bukan webhook Gojek. Kita yang poll.
