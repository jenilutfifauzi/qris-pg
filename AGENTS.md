# qris-pg

Integrated QRIS payment kit on **Cloudflare Workers** (D1 + cron + static WebUI).

Merges ideas from:
- `/mnt/data/qris-static-to-dynamic` → `src/qris.js`
- `/mnt/data/gopay-reverse` → `src/gobiz.js`
- `/mnt/data/bot-sell-grok` allocateUniqueAmount / claim → `src/db.js` + `src/poll.js`

## Stack
- Worker `src/index.js` (fetch + scheduled)
- D1 `env.DB` · migration `migrations/0001_init.sql`
- Assets `public/` · API key `env.API_KEY` (secret)
- Cron `* * * * *` → `runPoll`

## Local
```bash
cp .dev.vars.example .dev.vars
npm i && npm run db:local && npm run dev
npm test
```

## Deploy
1. `wrangler d1 create qris-pg` → set `database_id` in wrangler.jsonc
2. `npm run db:remote`
3. `wrangler secret put API_KEY`
4. `wrangler deploy`

## Don't
- Commit `.dev.vars`, tokens, real QRIS production payloads if secret
- Treat GoBiz mutasi as official API
