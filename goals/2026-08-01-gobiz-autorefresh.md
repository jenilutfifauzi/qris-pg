# Goal: qris-pg — access token via password login + auto-refresh end-to-end

## Constraints
- Stack: Cloudflare Workers + D1, repo `/tmp/qris-pg`, prod `https://qris-pg.jenilutfifauzi18.workers.dev`
- Akun GoBiz: jenilutfifauzi18@jenioslab.com (password login, BUKAN OTP — user insist)
- Auto-refresh sudah diimplementasikan & deployed (commit f8330a3); yang kurang: refresh token tersimpan + E2E
- must verify: refresh token tersimpan (gobiz_refresh_set:true), poll saat 401 → refreshed:true + token baru kepersist

## Phases
| # | Phase | Size | Scope | Done when | Status |
|---|-------|------|-------|-----------|--------|
| 1 | RE + implement auto-refresh worker | M | endpoint /goid/token, refreshToken() di gobiz.js, retry 401 di poll.js, field UI + settings | deploy sukses, /api/settings JSON, basic auth 401/200 | done |
| 2 | Fix routing assets (run_worker_first "/*") | S | API produksi balik JSON + dashboard auth jalan | curl /api/settings → JSON, / tanpa auth → 401 | done |
| 3 | Password login → simpan token | S | login/request(login_type=password) → token(grant_type=password) → PUT /api/settings (gobiz_token + gobiz_refresh) | gobiz_token_set:true DAN gobiz_refresh_set:true | done |
| 4 | E2E auto-refresh | S | set gobiz_token garbage → POST /api/poll → refresh terjadi, token baru tersimpan | poll response refreshed:true + settings token_set:true | done |

## Phase Log
- 2026-08-01 Phase 1 done: refresh flow terbukti (201, rotating), worker deploy, verifikasi /api/settings JSON + basic auth.
- 2026-08-01 Phase 2 done: run_worker_first ["/*"] — API balik JSON, dashboard 401/200, UI field Access+Refresh Token live.
- 2026-08-02 Phase 3 done: password login headless terbukti (login/request → token, X-UniqueId+cookie jar SAMA), access_token 2248 chars + refresh_token 635 chars tersimpan, refresh_set:true.
- 2026-08-02 Phase 4 done: E2E — garbage token → poll → `refreshed:true` (invoice pending dibuat dulu; poll short-circuit kalau nggak ada pending). Poll kedua `refreshed:false` = token real, self-healing terbukti. Invoice e2e eff5fd31f3db4c76 pending (amount 1 sudah ter-claim historic) — expire otomatis via cron.

## Next up
- Semua phase done. Goal tercapai: password login headless + auto-refresh E2E terbukti (refreshed:true).
- Opsional lanjutan: login helper bisa di-commit ke repo (scripts/gobiz-login.py) biar refresh token bisa di-refresh manual tanpa browser; alamat rate limit 429 (jeda 25 min, jangan spam).
