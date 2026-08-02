# Goal: Docsify docs qris-pg jadi profesional (konsisten, lengkap, polished)

## Constraints
- Repo: /tmp/qris-pg (remote jenilutfifauzi/qris-pg), Pages live di jenilutfifauzi.github.io/qris-pg
- Bahasa: **Indonesia konsisten** (UI + README sudah Indonesia)
- Stack: docsify v4 (CDN), jangan tambah dependency baru
- must verify: Pages 200 + semua halaman sidebar render + mermaid/cover jalan

## Phases
| # | Phase | Size | Scope | Done when | Status |
|---|-------|------|-------|-----------|--------|
| 1 | Dasar: bahasa konsisten, typo, sidebar, callouts | S | README/api rewrite konsisten Indonesia, fix typo, sidebar lengkap, `> [!WARNING]` | semua file .md konsisten B.Indonesia | **current** |
| 2 | Halaman baru: deploy + troubleshooting | S | docs/deploy.md + docs/troubleshooting.md (pitfall nyata) | 2 file render di Pages | pending |
| 3 | API completeness: error codes, env vars, DB schema | S | tabel error codes, env vars, schema D1 di api.md | tabel ada + akurat sama kode | pending |
| 4 | Polish: cover, badges, mermaid, CHANGELOG | S | _coverpage.md, badges README, mermaid plugin, CHANGELOG.md | cover + diagram render | pending |
| 5 | Verify + push | S | commit, push, cek Pages 200 + render | Pages 200, cover+sidebar+mermaid render | pending |

## Phase Log
- (belum ada)

## Next up
- Eksekusi phase 1-5 (user minta langsung semua, verifikasi akhir di Pages)
