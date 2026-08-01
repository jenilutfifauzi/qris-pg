# Plan: fix production gaps — qris-pg

Repo: `/tmp/qris-pg` (commit `aa6b2bd` + hardening fixes applied, 7 tests pass)

## Goal

Tutup 4 gap produksi yang tersisa dari review: (1) callback tanpa verifikasi, (2) create invoice dobel saat retry, (3) poll trigger tanpa throttle, (4) rate-limit window burst.

---

## Step 1 — HMAC signature di callback (verifikasi webhook)

**Masalah:** merchant endpoint nggak bisa buktikan callback beneran dari qris-pg.

**Approach (paling lazy):** pakai `env.API_KEY` sebagai shared secret — nol config baru, nol migration. Sign raw body dengan HMAC-SHA256 via `crypto.subtle` (native Workers, zero dep).

- `src/poll.js`:
  - `sendCallback(invoice, secret)` — setelah `JSON.stringify(body)`, hitung `sig = hex(hmac_sha256(secret, bodyStr))`, kirim dengan header `X-Qris-Signature: sha256=<sig>`. Pakai `bodyStr` yang sama untuk fetch body.
  - `retryUnsentCallbacks(db, secret)` — pass-through ke sendCallback.
  - `runPoll(env)` → `sendCallback(paid, env.API_KEY)`, `retryUnsentCallbacks(db, env.API_KEY)`.
- `src/index.js`: `POST /api/poll` sudah pass `env` — no change.
- **Test update:** `test/qris.test.js` — `sendCallback(inv)` → `sendCallback(inv, "testkey")`. Test baru: local http server, tangkap header `X-Qris-Signature`, verify server-side pakai key sama → cocok.
- **Merchant side:** verifikasi = HMAC-SHA256(raw body, API_KEY) == header. Catat di README API section.

**Skipped:** timestamp/replay window (`paid_at` sudah di body), per-merchant secret terpisah — add when multi-merchant butuh key berbeda dari admin key.

## Step 2 — Idempotency key di create invoice

**Masalah:** merchant retry POST → invoice dobel.

**Approach (paling lazy):** reuse `merchant_ref` sebagai idempotency key — nol kolom baru.

- `src/db.js`: `findPendingByRef(db, ref)` — `SELECT * FROM invoices WHERE merchant_ref = ? AND status = 'pending' LIMIT 1`.
- `src/index.js` POST `/api/invoices`: kalau `body.merchant_ref` ada, cek pending dulu → ketemu return existing (201), nggak ketemu lanjut create. Paid/expired dengan ref sama → invoice baru (semantik: ref reuse setelah lunas/expire itu wajar).
- **Test:** fake-db — findPendingByRef balikin row pending, create path return existing. Satu check.

**Catatan:** race create dobel tetap mungkin (dua POST bersamaan, dua-duanya belum lihat pending) — cuma bisa dieliminasi pakai unique partial index `on invoices(merchant_ref) WHERE status='pending'` + retry (pola sama kayak amount). **Skipped** — add when merchant retry concurrency nyata. Kalau mau, tinggal `migrations/0004` + 5 baris.

## Step 3 — Throttle poll trigger di GET /api/invoices/:id

**Masalah:** tiap GET status → `ctx.waitUntil(runPoll)` → key holder bisa hammer GoBiz.

**Approach:** minimal state via settings table (sudah ada, nol migration): key `last_poll_at` (epoch ms).

- `src/index.js` GET `/api/invoices/:id`:
  ```js
  const last = Number(await getSetting(env.DB, "last_poll_at") || 0);
  if (Date.now() - last > 30_000) {
    await setSetting(env.DB, "last_poll_at", String(Date.now()));
    ctx.waitUntil(runPoll(env));
  }
  ```
- Hardcode 30s + `// ponytail: 30s, enough for cron 1×/min; bump if hammered`.
- Race-safe cukup (worst case double poll; `claimed` PK sudah anti double-pay).

**Skipped:** lock/mutex antar isolate — add when poll cost beneran mahal.

## Step 4 — Rate limit burst (per-minute window)

**Verdict: NO-OP, accepted.** Burst :59+:00 = 20 create dalam 2 menit — pada 10/min dan personal-use, ini bukan eksploit (masih key-protected, create nggak cost mahal). Sliding window = kompleksitas tanpa manfaat nyata di skala ini.

**Add when:** API key dipake publik/integrator banyak → ganti ke sliding window (D1 simpan timestamp per request, count dalam 60s) atau Cloudflare Rate Limiting ruleset (native, nol code).

---

## Files touched

| File | Steps |
|------|-------|
| `src/poll.js` | 1 |
| `src/db.js` | 2 |
| `src/index.js` | 2, 3 |
| `test/qris.test.js` | 1, 2 |
| `README.md` | 1 (header signature di API section) |

## Validation

1. `node --test test/*.test.js` — semua pass (7 existing + ~2 baru).
2. Step 1: test HMAC verify di server-side (money path).
3. Step 2: test findPendingByRef (fake db).
4. Manual smoke: `npm run db:local && npm run dev` → create invoice 2× dengan merchant_ref sama → 1 invoice.

## Risks / open questions

- Step 1 ngirim API_KEY ke merchant = scope bleed (merchant bisa create invoice). Alternatif: secret terpisah di settings. **Default: reuse API_KEY** — personal use, satu pemilik. Tanya user kalau mau dedicated secret.
- Step 2 semantik ref-reuse setelah paid/expired: kalau merchant kirim ulang ref yang udah lunas → invoice baru (bukan error). Wajar untuk payment gateway. Konfirmasi kalau mau beda.
