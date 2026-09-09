# daily-log.md

## 2026-09-07

Repo scaffolded in an empty directory. Written: `schema-target.md`,
`mapping-legacy-to-target.md`, `open-questions.md`, `decisions.md`,
`design-brief-for-astra.md`, this log, `egress-log.md`.

`schema-current.md` intentionally left empty — no Supabase access this session (Q0).
No migrations written. No UI code written. No DB touched.

Blocked on: Q0 (credentials), Q1/Q2 (user maps), Q3 (legacy unit prices), Q10 (SLA value).
Design deliverables 1 and 2 pending from Astra.

## 2026-09-07 (later)

Credentials received. Connected to project `gcmexzynmygvwymnfutw` (ap-south-1, Free, t3.nano)
via the Session pooler. Built `scripts/inspect-db.mjs` (read-only) and ran it.

Result: **the project is empty.** 0 tables in `public`, 0 `auth.users`, 0 storage objects,
no migrations, no backups. 10 MB is Supabase internal schemas only. This contradicts
PROJECT.md, which says a partial staging DB exists. Logged as D-013, blocking on Q0b.

Also found: `pg_cron` and `citext` not installed (D-014, D-015). Postgres 17.6.

Nothing written to the database. No DDL, no DML.

### Migrations applied

Enabled `pg_cron` and `citext` (D-014 superseded — citext installed cleanly).
Wrote and applied migrations 001-009, each with a `down`. Runner: `scripts/migrate.mjs`.

Smoke-tested in a rolled-back transaction: Golden Customer uniqueness, pincode CHECK,
order_no sequence, RRR clock (4 touches on dispatch of a 15d course: D+3/D+8/D+11/D+17),
`next_followup_at` generated column, customer rollups, audit allowlist (accepts and rejects),
cancelled-consultation reason requirement, seed counts, nightly cron. All pass.

Found D-016: node-postgres parses `date` at local midnight, so `.toISOString()` reports the
previous day in IST. Affects the RRR clock if the frontend does this. Recorded.

DB now: 28 tables, 4 views, RLS on+forced everywhere, deny-all pending the policy migration.

### RLS (Phase 0 step 4) complete

Migration 011: helper functions + policies for every table, plus `v_pool_leads`.
`scripts/test-rls.mjs` — 27 assertions, impersonating real `authenticated` JWTs
(set role + request.jwt.claims), the same path PostgREST uses. All 27 pass.

Two real bugs found by the tests, both fixed in 011 before it shipped:
- infinite policy recursion customers -> consultations -> customers (D-019)
- pool leads needed a definer view for column masking (D-020)

Phase 0 status: steps 1-4 done. Step 5 (import) blocked on the actual export files.
Step 6 (backups) blocked on a GitHub repo + R2 credentials.

Confirmed: only 2 of the 9 sheet tabs are authoritative for the new sales team —
`Consultation Record` and `Medicine Order Record`. Other 7 archive to R2. Mapping doc
sections 3 and 4 renamed to those tabs. New Q21: confirm dispatch/courier/payment columns
live inside those two tabs, else the RRR clock cannot start for imported orders.

### Source files profiled

Both July tabs received and profiled (`scripts/profile_sheets.py` -> `docs/source-profile.md`).
Consultation Record: 536 rows x 34 cols. Medicine Order Record: 171 rows x 34 cols.

Two findings that change the plan:
- D-021: the "~87 shifted column" rows are NOT shifted. All 536 rows have exactly 34 fields.
  "Follow up" is a deliberate literal co-occurring with Conversion Type. ~90 legitimate rows
  would have been wrongly quarantined by the planned import.
- D-022: there is NO dispatch date column. The RRR clock cannot start for imported orders.
  Blocking on Q22.

Sales team identified from the data: Shreyansh, Tejasv, Ashutosh (Q1 partly answered).

### Team, pricing, SLA all loaded

Migrations 012-014: `auditor` role added (8th role, restrictive no-write policies);
product prices + course days from the pricing board; concerns; the new couriers,
payment modes and lead sources found in the export; SLA default of 15 minutes.

`scripts/seed-team.mjs`: 8 login accounts + 5 doctor records created without email
verification. Temp password Kamour@2026 (must rotate). Ashutosh manages Shreyansh + Tejasv.

Price board reading verified by arithmetic before loading - all 8 rows reconcile.

Nakul confirmed as `ops`. Checked kamour.in for the two unpriced combos: the site
403s all automated requests (Cloudflare). kapeefit.com served the page instead.
Combo CONTENTS recovered and consistent across sources; PRICES conflict with the wall
board by ~Rs 1,300 on the 15-day. Nothing loaded - Q29 updated, awaiting confirmation.

### July sheets imported

501 customers, 534 consultations, 168 orders, 392 order items, 539 followups.
23 honest rejects. Repeat orders = 70, exactly matching PROJECT.md. See docs/import-report.md.
Two importer bugs found and fixed during dry runs (D-032 date-as-status, D-033 legacy dispatch).

### Zoho Consultation Leads export received

52,177 rows x 58 cols, zero ragged. Record Id 100% unique; phones 99.5% valid.
12-month window = 11,728 rows (40,449 to archive). 459 of the 501 sheet customers match.
11,046 new customers. Profile in docs/zoho-profile.md.

The "Zaid / Zaid WATI" duplicate pattern is confirmed live and systematic - same phone,
one funnel row + one WATI row with a " WATI" name suffix.

Zoho Owner column is useless (3 system accounts). Real attribution is Follow-up N Done By,
which surfaces staff not on the team list. Blocking on Q31-Q33.

### Backups + first real end-to-end auth test

Supabase Storage private bucket db-backups; upload verified by re-download (D-035).
R2 blocked - needs a card the user does not have. Off-provider copy still outstanding.

Found and fixed D-036: every hand-created login was broken (NULL token columns ->
GoTrue 500). Only surfaced by testing an actual login through the API.

D-037: anon key returns 401 on everything; Shreyansh logged in sees exactly his own 71 orders.

### Full Zoho history imported (all 52,177 rows)

51,316 customers, 51,927 leads, 21,272 followups. DB 65 MB of 500 MB free.
607 customers merged from multiple Zoho records - the Zaid/WATI pattern, exactly as predicted.
Zero duplicate phones, zero orphans. 38,334 leads in the pool, masked.

Three bugs found and fixed mid-import: unique email index was wrong (D-042),
Age=0 rows (D-043), and two stale RLS count assertions (D-045).

### Phase 1 started: auth, role routing, shell, Aaj Ka Kaam

Next 15 + TS strict + Tailwind v4 scaffolded. Build passes, 0 npm vulnerabilities.
Login page (Hinglish), middleware auth gate, role-based landing, nav shell with dark mode.
Aaj Ka Kaam reads v_aaj_ka_kaam with named columns and .range(0,49).

FIVE real bugs found by running the app against real data, all fixed:
- D-047 queue showed every person twice (31,922 rows for 15,961 people)
- D-048 all 15,961 historical leads showed as SLA breaches
- D-049 RLS functions ran per-row -> statement timeout; now 116ms
- D-050 auditor could not read anything (restrictive FOR ALL blocks SELECT)
- D-051 manager saw their own team phones masked

### English + visual direction change

D-053: UI switched from Hinglish to English (app strings, migration 021 for the view,
route /aaj-ka-kaam -> /today). label_hi columns kept, not dropped.
D-054: target look is modern/professional/premium (Linear, Vercel) but density is unchanged.
Palette handed to the design agent to replace, keeping the token structure.
docs/astra-prompt.md rewritten. PROJECT.md updated so the anchor doc no longer contradicts.

D-055: wrote docs/codex-prompt.md — Codex owns src/components and the module pages,
is barred from migrations/scripts/.env.local/data and from touching the database.
First task: headless virtualized grid behaviour. Still no version control (standing risk).

### Fixed design checkpoint 1 basic-look complaint

Root cause was NOT the HTML/CSS medium: (1) Inter was named in tokens.css but never linked,
so it fell back to Segoe UI; (2) zero icons anywhere. Fixed additively - Google Fonts link
+ a small lucide-style icon set in nav/toolbar/dialogs/rows. Verified: 46/46 contrast checks
still pass with identical ratios (nothing colour/geometry/logic touched), JS/CSS/HTML all
syntax-checked, svg tags balanced. Noted in the prototype README that this trades away its
original "no internet required" property (font now loads from Google Fonts CDN).

### Design review published; Vercel deploy flagged

Published docs/design/astra-phase-1 as a self-contained Artifact (Inter self-hosted as
inlined woff2, not a CDN link). Honored Codex/Astras existing design - no palette/layout
changes, only packaging. Verified: no stray html/head/body tags, all 5 core contrast ratios
recomputed against the assembled file and match the original exactly.

Flagged (not reverted): Codex deployed the real app to kamour-sales-os.vercel.app.
PROJECT.md explicitly bans Vercel (Hobby ToS + commercial use). Scanned all 8 public JS
bundles for secrets - only the anon key present, nothing else. Auth gating verified live.
Nothing leaked, but login is now internet-reachable with the shared temp password still
unrotated. Recommended: rotate password now, decide Vercel-vs-Cloudflare-Pages with user.

## 2026-09-09 · AI daily leads on the RRR screen

Second list on the RRR tab, chosen from a dropdown: today's 45, dealt 15/15/15, rebuilt by cron
at 04:30 IST. Migration 028 (D-069).

- The day's size is `sum(users.daily_lead_cap)`, the mix is `ai_lead_rules.share_pct` — both data,
  so neither "45" nor "15" nor "how much Kamour" is a deploy.
- Mix sized against the real base: overdue 20 / Kamour 15 / active 25 / cooling 20 / dormant 20.
  Simulated 20 consecutive days: 45 every day, minimum 7-day gap before anyone reappears.
- Each row carries a score out of 100 and the reason in words, the way the team's own sheet does.
- Today's list says who calls today; ownership still moves only through fn_assign_rrr_customers.
- One narrow RLS widening so a rep can open the fifteen they were dealt, gated to sales_exec and
  to today's run. scripts/test-ai-leads.mjs proves it is exactly that wide (26/26).
- Fixed in passing: the status message after logging a call was rendered inside the assign bar,
  which reps cannot see, so a rep got no confirmation.
