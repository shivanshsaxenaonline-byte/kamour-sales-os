# egress-log.md

Measured egress, logged after each phase. Baseline from an existing project in the same
Supabase org: **184 MB/day with 4 users** against a **5 GB/month** org-pooled free limit.

| date | phase / change | users | measured egress | DB size | note |
|---|---|---|---|---|---|
| _pending_ | Phase 0 baseline | — | — | — | needs Supabase access (open-questions Q0) |
| 2026-09-08 | Reviewed UI integration | — | Authenticated DB/Realtime egress not yet measured | Not queried | 50-row bounded lists; named view columns; detail reads only on expand; cached tab counts; no polling. Bundled Inter file measured at 48,256 bytes (web asset, not Supabase egress). |

Source: Supabase dashboard, Reports > Egress (Database + Realtime + Storage, separately).
Record `pg_database_size()` after every import batch — a batch that grows the DB toward 1.5x
its current size trips read-only mode.
