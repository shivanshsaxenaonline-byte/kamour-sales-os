# decisions.md

Every non-obvious choice, with its reason. Append only; supersede rather than edit.

---

### D-001 · 2026-09-07 · Design is handed to a separate agent (Astra)
Data model, mapping, migrations, RLS, import and application code are done here. UI/visual
design is produced externally from `docs/design-brief-for-astra.md`.
**Why:** the split was requested. The brief is written to be self-contained so the design does
not need schema knowledge, and to be lifted directly into code (token names match CSS custom
properties).
**Consequence:** Phase 1 grid implementation waits on deliverables 1 and 2 of that brief.
Everything up to and including the data layer does not.

### D-002 · 2026-09-07 · `schema-current.md` left empty rather than guessed
No Supabase access in this session. Per AGENT RULES #1, no assumption is made about the
staging DB's contents.
**Why:** a plausible wrong inventory is worse than a missing one; migrations built on it would
be built on fiction.

### D-003 · 2026-09-07 · `orders.next_followup_at` is a stored generated column
`generated always as (dispatch_date + course_duration_days - 4) stored`.
**Why:** PROJECT.md says this is a SQL formula and never AI. A generated column makes that
structurally true — no code path, present or future, can write a different value.

### D-004 · 2026-09-07 · The RRR schedule lives in a `course_plans` table, not in code
**Why:** a new course length (e.g. 45 days) becomes a row, not a migration plus a deploy.
The trigger reads the table.

### D-005 · 2026-09-07 · Audit field allowlist is a CHECK constraint
`audit_log.field` is constrained to the six named fields.
**Why:** PROJECT.md limits audit logging to protect the egress quota. As a convention it
erodes; as a constraint, an over-eager future trigger fails loudly instead of quietly burning
5 GB/month.

### D-006 · 2026-09-07 · List screens read from narrow views, not base tables
`v_leads_list`, `v_consultations_list`, `v_orders_list`, `v_aaj_ka_kaam`.
**Why:** "never `select *`" is a rule a component can forget. A view that does not contain
`raw_payload`, `notes` or `body` cannot leak them into a list payload no matter what the
client writes.

### D-007 · 2026-09-07 · `customers.lifetime_orders` / `lifetime_value` / `segment` are stored, not computed
Maintained by trigger and by a nightly cron.
**Why:** computing them per query means aggregating across orders on every list render. At
15 users on an 8-hour day that is the single largest avoidable egress line item.

### D-008 · 2026-09-07 · Duplicate customers are merged at import, and the loser row is kept
The losing row survives with `merged_into_id` set; all reads filter `merged_into_id is null`.
**Why:** legacy Zoho and WATI IDs must keep resolving. Hard-deleting the loser would orphan
every external reference, and a post-import dedupe would have to rewrite FKs across every
child table.

### D-009 · 2026-09-07 · Order-item unit prices are not fabricated for legacy rows
Pending Q3; recommendation is to leave `unit_price` null on imported historical rows.
**Why:** `order_items` is a prescription. A pro-rata split would put an invented number on a
medical record.

### D-010 · 2026-09-07 · Historical dispatches do not backfill past-due RRR follow-ups
The trigger is disabled during import; only touches still in the future are created.
**Why:** otherwise every rep's Aaj Ka Kaam opens on day one with thousands of overdue rows and
is abandoned immediately — which is exactly the failure the definition of done describes.
Older customers are reachable through segments (A1…C2), which is what segments are for.

### D-011 · 2026-09-07 · Unmappable legacy values are rejected, never auto-aliased
`import_rejects` holds them with a reason. An import with zero rejects is treated as a bug.
**Why:** the ~87 shifted-column rows in the July sheet are the precedent. Silently coercing
`Lead Source = "Follow up"` into some lookup value would reproduce the exact bug the schema
exists to make impossible.

### D-012 · 2026-09-07 · `order_stage` is an enum; sources/statuses/reasons are lookup tables
**Why:** each order stage drives distinct code (dispatch starts the RRR clock, RTO affects
incentive), so adding one is a code change by definition and should require a migration.
Lead statuses and reasons are business vocabulary and must be editable without a deploy.

### D-013 · 2026-09-07 · The Supabase project is empty; PROJECT.md's premise is stale
Project `gcmexzynmygvwymnfutw` (Mumbai, Free, t3.nano) inventoried as `postgres` superuser:
0 tables in `public`, 0 `auth.users`, 0 storage objects, no migrations, no backups.
PROJECT.md says a staging DB with partial data exists. It does not — at least not here.
**Why it matters:** step 2 (`schema-diff.md`) is meaningless until this is settled. Recorded
rather than assumed; awaiting confirmation that this is the intended project (open-questions Q0b).

### D-014 · 2026-09-07 · SUPERSEDED — `citext` was enabled, so `customers.email` keeps `citext`
Originally planned to drop `citext` for `text` + `lower()` index because the extension was
missing. `create extension citext` succeeded on this project, so the original design stands.
Migration 002 uses `citext` **and** a unique index on `lower(email)` filtered to live rows.

### D-015 · 2026-09-07 · `pg_cron` must be enabled before the segment migration; `pg_net` is not needed
The nightly A1..C2 recompute needs `pg_cron` (not installed yet). `pg_net` is not required
because all outbound calls originate from Edge Functions, not from Postgres.

### D-016 · 2026-09-07 · Postgres `date` columns must never be read through `toISOString()`
`node-postgres` parses a `date` into a JS `Date` at **local** midnight. In IST (+5:30),
`.toISOString()` then reports the **previous day**. Verified: the server computes
`next_followup_at = 2026-09-12`, and `.toISOString().slice(0,10)` renders `2026-09-11`.
**Why it matters:** `next_followup_at`, `dispatch_date` and `course_ends_at` are all `date`.
A one-day error in the RRR clock silently misses the repeat pitch — the exact revenue event
the product exists to catch.
**How to apply:** in queries, cast to text (`select next_followup_at::text`) or set
`pg.types.setTypeParser(1082, v => v)` so `date` arrives as a plain string. Never build a
display date from a JS `Date` via `toISOString`.

### D-017 · 2026-09-07 · RLS is ON with deny-all before the policy migration
Migration 008 enables and forces RLS on every table but creates policies only for the lookup
tables. `anon` is revoked outright.
**Why:** PROJECT.md orders migrations (step 3) before RLS policies (step 4). Between those two
steps a project with a public anon key and no RLS is an open database. Deny-by-default is the
correct intermediate state.
**Consequence:** until the policy migration lands, tables read as EMPTY through PostgREST even
when populated. `service_role` (Edge Functions, importer) bypasses RLS and works normally.

### D-018 · 2026-09-07 · `roles` is an enum (`user_role`), not a table
PROJECT.md's minimum table list names `roles`. Implemented as the `user_role` enum instead.
**Why:** the seven roles each gate distinct RLS policies and code paths, so adding one is a
migration by definition (same reasoning as D-012 for `order_stage`). A `roles` table would
imply roles are business-editable, which they are not — an unrecognised role in a lookup table
would silently grant nothing while looking configured.
**Revisit if:** per-role permissions ever need editing without a deploy.

### D-019 · 2026-09-07 · Cross-table checks in RLS policies live in SECURITY DEFINER functions
`customers_read` originally inlined `exists (select 1 from consultations ...)`. Postgres then
evaluated the `consultations` policy, which reads `customers`, which re-entered `customers_read`:
*"infinite recursion detected in policy for relation customers"*. Caught by the RLS tests, not by
review.
**Fix:** `app_owns_customer()`, `app_doctor_sees_customer()`, `app_ops_sees_customer()` —
SECURITY DEFINER, so the inner read bypasses RLS and the cycle breaks.
**Rule going forward:** a policy may reference its own table's columns freely, but any read of
*another* table goes through a definer helper. Adding a policy that inlines a cross-table
`exists` will eventually deadlock the graph again.

### D-020 · 2026-09-07 · The pool is a SECURITY DEFINER view; base-table rows stay denied
`leads_read` grants only `owner_id = auth.uid()`, so unassigned leads are invisible in the table.
`v_pool_leads` (definer, unlike the security_invoker list views) is the one sanctioned path to
them and returns `mask_phone(...)` instead of the number.
**Why:** RLS is row-level and cannot mask a column. Masking via a definer view means an exec who
crafts a direct PostgREST call against `leads` or `customers` gets nothing at all, rather than a
full phone number the UI merely hid. Proven by test: the raw phone does not appear in the view's
output.

### D-021 · 2026-09-07 · The ~87 "shifted column" rows are NOT a column shift
PROJECT.md states the July sheet has `Lead Source = "Follow up"` on ~87 rows because "columns
physically shifted", and the schema was justified partly as making that bug unstorable.
**The export disproves it.** Every one of the 536 rows has exactly 34 fields — nothing is
ragged, so nothing shifted. What actually happens: when `Conversion Type = 'Follow up'`
(93 rows), the team also types the literal `Follow up` into `Amount` (90), `Payment` (91) and
`Lead Source` (86). It is a data-entry convention meaning *"this consultation came from a
follow-up, so there was no fresh ₹99 payment and no fresh lead source."*
**Why this matters:** the planned import would have quarantined ~90 legitimate rows as corrupt.
**How to apply:** treat `Follow up` in those three columns as **NULL**, and carry the fact in
`consultations.conversion_type = 'follow_up'`. Do not reject. `import_rejects` is for genuinely
unparseable data, and these rows are perfectly well understood.

### D-022 · 2026-09-07 · There is no dispatch date in the source, so the RRR clock cannot start from it
`Medicine Order Record` has `Date of Order`, `Date of Consultation` and `Delivered Date` — and
no dispatch date, no AWB, no tracking column.
**Why it matters:** `orders.dispatch_date` is the trigger for the entire RRR clock, and
`next_followup_at` is generated from it. Imported orders would have a null dispatch date, so no
RRR follow-up would ever be created for any historical customer — the exact population the
product exists to recover.
**Blocked on Q22.** Do not pick a substitute silently: inferring dispatch from `Delivered Date`
shifts every RRR touch by the shipping time, and a repeat pitch sent on the wrong day is worse
than one not sent.

### D-023 · 2026-09-07 · Historical orders import with no dispatch date and create no RRR follow-ups
Confirmed by the user. The source has no dispatch date (D-022) and none is inferred.
**Consequence:** `orders.dispatch_date` is NULL for all 171 imported July orders, so
`next_followup_at` is NULL and `fn_create_rrr_followups` never fires for them. The old cohort is
worked through `customers.segment` (A1-C2) instead, which is what segments are for. Orders
created inside the app get a real dispatch date and a correct clock.
**Why:** a repeat pitch sent on a guessed date is worse than one not sent.

### D-024 · 2026-09-07 · `Conversion By` is the owner of record on an order
Confirmed by the user. `orders.original_owner_id` and `current_owner_id` both come from
`Conversion By` — the person who closed the sale. `Joined By` is not imported as an owner.
**Why it matters:** `original_owner_id` is frozen at import and incentive credit follows it
permanently, so this cannot be corrected later.

### D-025 · 2026-09-07 · Consultation fee of 9 is a real price, not a typo
User: *"sometimes we give for 99 some 9 some free according to customer source and wants."*
The consult fee is discretionary and set per customer. `Amount` imports verbatim:
`₹99` -> 99.00, `9` -> 9.00, `Free` -> 0.00, `Follow up` -> NULL (D-021).
**Consequence:** `consultations.fee_amount` gets no default and no CHECK pinning it to 99.
Q17 (is ₹99 fixed?) is answered: it is not.

### D-026 · 2026-09-07 · `Dr. Rupendra` and `Dr Rupender Singh` are one person
Confirmed by the user. One `users` row; both spellings map to it via the import alias map.
Same treatment for any other spelling variant found during import.

### D-027 · 2026-09-07 · Product prices are display defaults; order money stays never-auto-filled
Prices loaded from the "KAMOUR PRODUCTS PRICING - CGA FUNNEL" board (updated 21-05-2026). Each
row was verified as `MRP x (1 - discount%) = sale price` before being written, which confirmed
the reading of the photo — all 8 rows reconcile to the rupee.
User: *"price of product is flexible kabhi kabhi sales team discount bhi deti hai."*
**Consequence:** `products.sale_price` is a suggestion for the order form only.
`orders.amount` and `orders.discount` keep their never-auto-filled status and are typed per
order. No CHECK ties an order's amount to its products' list prices.

### D-028 · 2026-09-07 · Course length comes from the pack size: 30N = 15 days, 60N = 30 days
Confirmed by the user. 7-Day Booster Combo = 7 days. `products.default_course_days` set
accordingly. Power Drive, Boost Up Oil and Shilajit carry no N-count and are left NULL —
`course_duration_days` drives the RRR clock and is not guessable from a bottle.

### D-029 · 2026-09-07 · SLA is 15 minutes from lead creation
User: *"15 mins (possibly as soon as possible)."* `leads.sla_due_at` now defaults to
`now() + interval '15 minutes'`. A breach is rank 1 in Aaj Ka Kaam — above even a paid lead.

### D-030 · 2026-09-07 · `auditor` added as an eighth role
The team includes an Auditor (Alka); PROJECT.md's seven roles have no equivalent. Reusing `coo`
would make the audit trail misattribute who viewed what. `auditor` reads everything and is
blocked from writing by RESTRICTIVE policies on orders, customers, leads and followups —
restrictive rather than permissive, so the block cannot be undone by adding a later policy.

### D-031 · 2026-09-07 · Accounts created without email verification; doctors get records, not logins
User asked for IDs now, real emails later. Accounts are inserted straight into `auth.users` with
`email_confirmed_at` set and placeholder `@kamour.local` addresses, plus the matching
`auth.identities` row that password sign-in needs. Swapping in a real email later is one UPDATE
and breaks no foreign key, because every FK points at the uuid.
Doctors are `users` rows with `encrypted_password = null` and `is_active = false` — they cannot
sign in, but `consultations.doctor_id` resolves and per-doctor reporting works. Giving a doctor a
login later is a password update, not a data migration.
**Temp password `Kamour@2026` is shared across all 8 accounts and must be rotated.**

### D-032 · 2026-09-07 · `Consultation Date` doubles as a status marker
For the 82 Pending rows the column holds the literal `Pending`, and for the 8 Cancelled rows
`Cancel`/`cancel` — not a date. The first import run rejected all 90 as unparseable dates, which
is why zero pending and zero cancelled consultations appeared.
**Fix:** parse the status first, then fall back to `Payment Date` (filled on 73 of 82 pending
rows) for `scheduled_at`. A consultation that never happened legitimately has no consultation
date; only `state = 'done'` requires one.

### D-033 · 2026-09-07 · Legacy orders carry `is_legacy` to exempt them from the dispatch rule
`orders_dispatched_needs_date` forbids `delivered` without a `dispatch_date`, which is correct
for anything the app creates but impossible for the 127 delivered July orders (no dispatch date
exists in the source). Migration 015 adds `orders.is_legacy` and rewrites the constraint to
exempt only those rows.
**Why not weaken the rule:** new orders keep the guarantee. Marking the exception is honest;
removing the rule would quietly permit the same gap forever.

### D-034 · 2026-09-07 · Legacy follow-up `outcome` stays NULL; the raw text is kept
The follow-up cells are well structured — `24-07-2026 | Shreyansh Call Not Pick` — so the date
and the owner are parsed out reliably. The outcome is NOT classified from the remaining text.
**Why:** the pool rule ("moves to pool after 2 failed connect attempts") reads `outcome`.
Keyword-guessing `connected` vs `no_answer` from Hinglish free text would fabricate exactly the
signal that decides who owns a customer. `remark` keeps the full original text, so a human or a
later pass can classify it without data loss.

### D-035 · 2026-09-08 · Backups go to Supabase Storage for now, because R2 needs a card
Cloudflare R2 requires a payment method the user does not have, so PROJECT.md's "Files -> R2"
is not achievable today. Private bucket `db-backups` created in the same Supabase project;
`scripts/backup-upload.mjs` packs, uploads, verifies by re-download, and prunes to 7 daily +
4 weekly (free tier is 1 GB).
**This is a convenience copy, not disaster recovery.** It lives in the same project as the
database it protects, so a suspended or deleted project loses both. The off-provider copy —
a private GitHub repo, or R2 later — is still outstanding and still matters.
Current size: 2,274 rows -> 0.15 MB gzipped, so quota is not a near-term concern.

### D-036 · 2026-09-08 · Hand-made `auth.users` rows must have empty strings, not NULL, in the token columns
Every account created by `seed-team.mjs` could not log in: GoTrue returned
`500 "Database error querying schema"`. Cause: `confirmation_token`, `recovery_token`,
`email_change_token_new`, `email_change_token_current` and `email_change` were NULL. GoTrue
scans them into non-nullable Go strings, so one NULL fails the entire query — and the account
looks perfectly normal in the table.
Fixed in the database and in the script. `phone` is deliberately left NULL: it carries a unique
index, so `''` would collide across rows.
**Only found because the login was actually tested end to end.** The RLS suite runs over a
direct database connection and would never have caught it.

### D-037 · 2026-09-08 · Anon-key exposure verified against the live API, not just in tests
With only the public anon key (the one that ships in the frontend bundle), every table, view and
the storage bucket return 401. After a real password login, `sales_exec` Shreyansh sees 385 of
501 customers, **71 of 168 orders — exactly his own 71** — 1 user row (himself), 0 audit_log.
This is the PROJECT.md requirement ("must not read another exec's rows even with a crafted API
call") demonstrated through PostgREST rather than inferred from policy source.

### D-038 · 2026-09-08 · Tejas = Tejasv (one person); the two Ashutoshes are different people
Confirmed by the user. `Tejas` (828 follow-ups) and `Tejasv` (536) are one person and map to the
same `users` row. `Ashutosh Pal` and `Ashutosh Saxena` are two distinct people.
**Ashutosh Pal is the team's Ashutosh** (sales_manager) — 2,122 follow-ups, 1,453 of them inside
the last 12 months, consistent with a currently active team member. `Ashutosh Saxena` (230 total,
1 recent) is treated as former staff under D-039.

### D-039 · 2026-09-08 · Former staff become inactive users, not null owners
Confirmed by the user. Anshu Chauhan, Tripti Chauhan, Harshal Deep, Nisha, Saloni Srivastava,
Varun Kumar, Priyanka, Prerna Agarwal and Ashutosh Saxena get `users` rows with
`is_active = false` and no password.
**Why:** roughly 15,000 historical follow-ups keep their real author. They cannot log in and are
filtered out of every dropdown by `is_active`, so they add no noise to the working app.
The alternative — a null owner — would permanently erase who did the work.

### D-040 · 2026-09-08 · Database size is not the binding constraint; egress is
Measured, not assumed (see `docs/capacity-plan.md`). Real row cost with indexes is ~470 B per
customer and ~410 B per follow-up, so all 52,177 Zoho leads would occupy ~95 MB of the free
tier's 500 MB, and growth runs ~2.5 MB/month at the current ~1,200 leads/month.
**Consequence:** the import window is a data-quality decision, not a cost one. Egress is
unaffected by row count as long as lists stay paginated and narrow — which is what the hard
constraints already enforce.

### D-041 · 2026-09-08 · Full Zoho history imported — all 52,177 rows, no archive cut
User chose lifetime history over the 12-month window, after `capacity-plan.md` showed row count
is not the binding cost (D-040). Result: 51,316 customers, 51,927 leads, 21,272 follow-ups,
**65 MB of the free tier's 500 MB**. Nothing was archived to R2, so PROJECT.md's
"import 12 months, archive the rest" step is superseded.

### D-042 · 2026-09-08 · Email is NOT unique; phone is the only identity key
Migration 002 put a unique index on `lower(email)`. The Zoho export disproves it — 6 addresses
are shared by 12 people, including `hello@kapeefit.com`, the company's own address entered when
a customer had none. Migration 016 replaces it with a plain index.
**How it surfaced:** the importer generated a uuid for a new customer, `on conflict do nothing`
silently skipped the insert because of the *email* index, and the child rows then failed on a
foreign key. A unique constraint on a field that is not an identity does not reject bad data —
it silently drops good data.
The importer now re-reads ids after insert and remaps children, so no future unique index can
orphan rows this way.

### D-043 · 2026-09-08 · Zoho `Age` holds 0, birth years and phone numbers
524 rows have `Age = 0`, plus a `225` and a 9-digit number. All become NULL rather than being
clamped: a clamped age is a fabricated fact about a patient.

### D-044 · 2026-09-08 · Name de-suffixing uses word boundaries, deliberately
`cleanName` strips a trailing ` WATI` channel suffix to merge "Pankaj Chauhan WATI" into
"Pankaj chauhan". It matches on a word boundary, so the 12 customers actually named Swati,
Bhagawati, Parwati and Inwati are untouched. A naive suffix strip would have corrupted real names.

### D-045 · 2026-09-08 · RLS tests must never assert absolute row counts
Two assertions broke as real data arrived ("ceo sees all orders" expected 1, "pool has 1 lead").
Neither was a security failure; both measured the size of the import. Assertions now compare
against live totals or filter to their own fixture.

### D-046 · 2026-09-08 · Next 15 stays locked; postcss pinned by override, TypeScript pinned to 6
`npm audit` reported a high-severity postcss chain inside Next 15 whose only offered fix was
Next 16 — a major bump against a locked stack. `overrides: { postcss: ^8.5.28 }` forces the
patched build everywhere: **0 vulnerabilities, Next 15 untouched.**
TypeScript 7 is likewise rejected by Next 15 ("does not provide the JavaScript compiler API"),
so TS is pinned to ^6. `baseUrl` was then removed because TS 6 deprecates it; the `@/*` alias is
set explicitly in `next.config.mjs`, which is also what made webpack resolve it at all.

### D-047 · 2026-09-08 · Aaj Ka Kaam buckets must be mutually exclusive
The original view put one uncontacted, unpaid, SLA-breached lead into both bucket 1 and bucket 5:
**31,922 rows for 15,961 people.** Every rep would have worked each person twice. Buckets 2 and 5
now exclude rows bucket 1 already owns. One person, one row, at their highest-priority reason.

### D-048 · 2026-09-08 · Imported leads carry no SLA deadline
`sla_due_at` defaults to now() + 15 minutes, so the Zoho import stamped it on all 15,961
uncontacted historical leads — some from 2023 — and every one showed as a rank-1 SLA BREACH.
Migration 018 nulls it for `channel = 'zoho_legacy'`. Same principle as D-010: history must not
masquerade as today's urgency. Queue now reads Tejasv 182, Ashutosh 19, Shreyansh 0, pool 15,316.

### D-049 · 2026-09-08 · RLS policies wrap function calls in scalar subqueries
`using (owner_id = auth.uid() or app_can_read_all())` re-evaluated both functions **per row**.
Across 51,927 leads joined to 51,316 customers, Aaj Ka Kaam hit the statement timeout (57014) for
every sales user. `(select auth.uid())` and `(select app_can_read_all())` make them InitPlans
evaluated once per query. Identical semantics; **timeout -> 116 ms**.
Rule: any function call in a policy predicate goes in a scalar subquery.

### D-050 · 2026-09-08 · A RESTRICTIVE `for all` policy blocks SELECT too
The auditor's write-block from D-030 used `as restrictive for all using (app_can_write())`.
`for all` includes SELECT, so Alka — whose entire role is reading everything — saw **zero rows**.
Split into per-command restrictive policies for INSERT, UPDATE and DELETE.
Found by logging in as her, not by reading the policy.

### D-051 · 2026-09-08 · Masking depends on assignment, not on who is looking
The queue masked whenever `owner_id <> auth.uid()`, so a sales_manager reviewing their own team
saw `79••••1046`. PROJECT.md masks "for unassigned leads". RLS already decides *whether* a row is
visible; masking answers the narrower question of whether the lead has been claimed.
Now: `owner_id is null` -> masked for everyone. Verified — manager sees `90••••9154` on pool rows
and the full number on assigned ones.

### D-052 · 2026-09-08 · Design handoff is a paste-ready prompt, with synthetic sample data
`docs/astra-prompt.md` replaces `design-brief-for-astra.md` as the thing handed to ChatGPT.
Written as a prompt rather than a spec document, and updated to match what is actually built:
the five real queue bucket names, the Hinglish strings already in the code, the shell that
exists, and real volumes (one rep has 182 items, another 0).
**Sample rows in the prompt are invented.** Real customer names and phone numbers are not pasted
into an external chat service — the brief says so explicitly so it does not happen later either.
The prompt also asks Astra to raise questions before designing, and to flag anywhere the design
fights shadcn primitives so the component gets rebuilt rather than approximated.

### D-053 · 2026-09-08 · UI language is English, not Hinglish
Owner's decision, superseding PROJECT.md's "UI labels in Hinglish (Latin script)".
Changed in the app (login, Today, nav, module pages) and in the database — `action_label` in
`v_aaj_ka_kaam` was the only user-facing string stored in SQL (migration 021). The route
`/aaj-ka-kaam` is now `/today`.
`label_hi` columns on the lookup tables are **kept, not dropped**: removing them destroys data
to save nothing, and the decision could be revisited.
**Noted for the record:** the original Hinglish rule existed because the users are a Bareilly
sales floor working at spreadsheet speed. If the team turns out to read the English labels more
slowly, this is worth revisiting — the cost would show up as hesitation on the queue screen,
not as an error anyone reports.

### D-054 · 2026-09-08 · "Modern SaaS" is reconciled with density, not traded against it
Owner asked for a modern, professional SaaS look with a strong colour palette. PROJECT.md
explicitly rejects the generic SaaS aesthetic, so the two needed reconciling rather than one
overriding the other.
**Resolution:** premium via typography, spacing rhythm, colour discipline, border quality and
considered focus/hover/empty states — not via gradients, shadows, cards or size. Linear and
Vercel are the reference precisely because they are modern *and* dense.
The density constraints stand unchanged: 13px base, 32px rows, 20+ rows at 1366×768. The design
prompt names this tension explicitly so the design agent does not deliver an airy 16px dashboard
showing 8 rows — which would send the team back to the spreadsheet, i.e. fail the definition of
done regardless of how it looks.
**The colour palette is now open.** The design agent proposes a full light+dark token set with
stated WCAG AA ratios, keeping the structure (one accent, three semantic pairs) so the existing
CSS variables and every component keep working on swap.

### D-055 · 2026-09-08 · TWO-agent split, divided by FILE not by feature
**Corrected same day:** "Astra" is the model inside Codex (GPT-6 Astra), not a separate agent.
So there are two, not three:
Claude (this agent): database, migrations, RLS, imports, data layer, wiring.
Codex / GPT-6 Astra: visual design AND frontend — colour system, `src/components/**`, module pages.
**Why by file:** two agents editing the same file is unrecoverable without version control.
`supabase/migrations/**` in particular cannot be shared — 21 numbered migrations are applied to
the live database, and editing an applied one silently desynchronises the schema from the code.
Codex's brief (`docs/codex-prompt.md`) forbids migrations, `scripts/**`, `.env.local`,
`data/incoming/**` and any database connection, and tells it to stop and report rather than work
around anything in another agent's area.
**Standing risk:** there is still no version control. With one agent that was untidy; with three
it is the single largest project risk, and it is not a technical blocker — `git init` is local
and needs no GitHub account.

### D-056 · 2026-09-08 · Codex runs with Full access on a repo holding live credentials
Observed in the VS Code panel: Codex is set to **Full access**, and `.env.local` in this folder
contains the live database password, the Supabase service-role key (which bypasses RLS entirely)
and the anon key.
**Standing risks, both currently unmitigated:**
1. Nothing prevents an agent reading `.env.local` and echoing a secret into a chat transcript.
   The brief forbids it; nothing enforces it.
2. Still no version control. With one agent that was untidy; with two agents in Full access mode
   on 21 applied migrations and 51,316 imported customer rows, an overwrite is unrecoverable.
`git init` is local, needs no GitHub account, and closes risk 2 entirely.

### D-057 · 2026-09-08 · Design checkpoint 1 read "basic" because no font loaded and no icons existed, not because it was HTML/CSS
User reported the Codex/Astra prototype (`docs/design/astra-phase-1/`) looked basic and asked
for a "modern SaaS" look, attributing it to the HTML/CSS medium. Investigated before acting:
the medium is not the cause — production also renders to HTML/CSS. Two concrete causes found:
1. `tokens.css` names `Inter` as the font but nothing ever linked it, so the browser silently
   fell back to Segoe UI (Windows' default UI font) — the single biggest driver of a generic
   "unstyled Windows dialog" read.
2. Zero icons anywhere in the prototype — nav, toolbar, dialogs, row affordances were all plain
   text.
Neither is a flaw in the design *decisions* the prototype was auditing (flat surfaces, no
shadows/gradients, restrained colour) — those were correctly implementing the brief, which
explicitly rejects decoration. Fixed directly, additively: Google Fonts link for Inter, and a
small hand-drawn stroke-icon set matching `lucide-react` (shadcn/ui's default) visual language,
added to the nav, toolbar, dialogs, empty state, brand mark, and the row-level lock/presence/
expand affordances. **Zero colour tokens, contrast pairs, row geometry, pill markup, or
interaction logic were touched** — `node docs/design/astra-phase-1/verify-contrast.mjs` still
reports 46/46 passing with identical ratios after the change, confirmed by rerun.
**Traded away:** the prototype's original "no internet connection required" property, since the
font now loads from `fonts.googleapis.com`. Flagged in the prototype's own README rather than
silently dropped; a self-hosted woff2 is the fix if that property is needed back.

### D-058 · 2026-09-08 · Design review published as a self-contained Artifact, honoring the existing design rather than redesigning it
User asked to "deploy" the design-review prototype. Per the artifact-design skill's "honor what's
already there," the palette/layout/interaction decisions are Codex/GPT-6 Astra's and were not
touched — only packaging changes were made: the 4 files (index.html/tokens.css/review.css/
review.js) combined into one self-contained HTML page, Inter self-hosted as a single 48KB
variable-font woff2 (all 4 weights) inlined as a base64 data URI rather than a Google Fonts
`<link>`, restoring the "no external network request" property the prototype's own handoff notes
ask for and that my D-057 patch had traded away. Added the missing `@media (prefers-color-scheme:
dark)` block, guarded per the artifact 3-state theme contract, since the original hardcoded
`data-theme="light"` on `<html>` — a tag an Artifact page cannot write itself. Verified before
publish: no stray `<html>/<head>/<body>/<!doctype>` tags, braces/svg-tags balanced, and — the one
check that actually matters — recomputed all 5 core contrast ratios (text/bg, accent/bg, and the
three status pills) against the assembled file's own CSS in both themes; **every ratio matches
the original prototype exactly**, confirming reassembly changed no token value.

### D-059 · 2026-09-08 · Codex deployed the real Next.js app to Vercel — flagged, not reverted
Observed: Codex deployed the actual application (not the design prototype) to
`kamour-sales-os.vercel.app`. PROJECT.md's locked stack explicitly states
"Web host: Cloudflare Pages (**NOT Vercel** — Hobby bans commercial use)" — a recorded decision
about Vercel's own Terms of Service for the free tier on commercial projects, not a style
preference. I did not revert or redeploy anything; this is the user's call, not mine to make
unilaterally, and reverting a teammate's deploy without discussion is its own kind of overreach.
**Checked, not assumed:** scanned all 8 client-side JS bundles Vercel serves to the public
`/login` route for anything credential-shaped. Found exactly one JWT — role `anon` — the key that
is supposed to ship in every browser bundle and is meaningless without RLS being wrong (D-037
proved it is not). **No service-role key, no `SUPABASE_DB_URL`, no `postgresql://` literal**
anywhere in the public bundles. Auth gating also verified live: `/` and `/orders` both 307 to
`/login` for an unauthenticated request. So nothing has actually leaked.
**What changed in risk, regardless of the Vercel decision:** the login endpoint, and the shared
temporary password (`Kamour@2026`, all 8 team accounts, D-031), are now reachable from the open
internet rather than only from a laptop. That was always the eventual state once *any* hosting
went live, but it arrived sooner and on a different platform than planned, without the DB
password rotation (open since D-035/D-056) having happened first.
**Recommendation, not yet actioned:** rotate the shared team password now that a real login
surface is internet-reachable; separately decide, with the user, whether to keep Vercel for
now (private staging use is likely fine even under a ToS read that bars *production commercial*
traffic) or move to Cloudflare Pages per the original plan before this is customer-facing.

### D-060 · 2026-09-08 · Vercel accepted as the host, superseding PROJECT.md's Cloudflare Pages choice
User: "just deploy" — in direct response to the D-059 fork. Read as accepting the existing
`kamour-sales-os.vercel.app` deployment rather than migrating to Cloudflare Pages.
**Consequence:** PROJECT.md's stack table ("Web host: Cloudflare Pages, NOT Vercel — Hobby bans
commercial use") is superseded for now. If this project moves from private/staging use toward
real commercial traffic, Vercel's Hobby-tier ToS restriction becomes live again and is worth
revisiting before that happens — not blocking today's use.
**Still open, not covered by this message:** rotating the shared team password
(`Kamour@2026`, all 8 accounts) now that the login endpoint is internet-reachable. Not actioned
silently — changing it without warning would lock out the real team mid-use. Flagged again,
left for the user to schedule.

### D-061 · 2026-09-08 · ID-picker made the live login page, not localhost-only
User: "just push to github and deploy with new version like i have said i want basic login page
with all ids." Changed `src/app/login/page.tsx` and `actions.ts`: the eight-ID click-to-login
picker (built by Codex, previously gated to `localhost`/`127.0.0.1`) is now controlled purely by
a server env var, with no host restriction, so it can run on the live Vercel deployment. Env var
renamed `KAMOUR_LOCAL_ACCOUNT_PICKER` -> `KAMOUR_ID_PICKER` since "local" no longer describes it.
**Tradeoff, flagged not hidden:** anyone who reaches the deployed URL can now sign in as any of
the eight team members with one click and zero typed credentials — the picker asks nothing of the
visitor. Auth still goes through real Supabase `signInWithPassword` server-side using
`SEED_TEMP_PASSWORD` (never sent to the browser), and an inactive profile is still rejected. This
matches the original spec ("ids without email authentication for now") and is accepted for a
small trusted internal team — documented in `docs/design/local-account-picker.md` as an explicit,
revisitable tradeoff.
**Still required to go live:** `KAMOUR_ID_PICKER=1` and `SEED_TEMP_PASSWORD` must be set as
server-side env vars in the Vercel project (never `NEXT_PUBLIC_*`) — no Vercel dashboard/API
access here, so the user needs to set these in Vercel's project settings and redeploy.

### D-062 · 2026-09-09 · KM002 sheets imported; incomplete rows kept, not dropped
User: "i want that all data in supabase to be stored as a place." Imported the KM002 Google Sheet
(the source behind the separate RRR Intelligence Dashboard) into the same `customers`/`orders`/
`order_items` tables, via `scripts/import-km002.mjs` (dry-run by default, `--tab=master|shop`).
Two source gaps turned out to cover most rows, and the first-pass importer rejected them the way
`import-sheets.mjs` rejects unreadable data (D-011):
**994 orders have no per-product columns** — those columns appear not to have existed in the sheet
before ~Oct 2025 — and **977 have no Course Duration**, almost always the same rows. Rejecting
both would have thrown away ~half the company's order history over columns the source never had.
User chose to keep them ("import without line items"), so migration **022** lets `is_legacy` rows
carry a NULL `course_duration_days` (same escape hatch 015 gave `dispatch_date`), and those orders
import with real customer/amount/date and simply no `order_items`. Consequence, stated plainly:
the RRR clock cannot schedule a repeat call for an order with no course length — it schedules
nothing rather than inventing a course length to schedule against.
Final: 1,835 + 156 orders in, 180 rejected with reasons in `import_rejects` (131 blank/broken
phone, 32 "Doctor" as the closer with no such user, 7 blank rows, 2 discount > amount).

### D-063 · 2026-09-09 · Order source recorded on the order; website orders stay unassigned
User: "ye orders bhi master ki tarah RRR me ayenge but usme likha hoga kamour.in or kamour.shop."
`customers.first_source_id` only answers where a CUSTOMER first came from, so it cannot say whether
a given order was a rep's conversion or a self-serve website checkout — and a repeat customer
genuinely has both. Migration **023** adds `orders.source_id`, plus `cga` / `kamour_in` /
`kamour_shop` lead sources. This also rescued the Master tab's own Source column (CGA 1,809 rows,
Flipkart, IndiaMART, Justdial), which the first import had been dropping entirely.
All 164 Kamour.in/Kamour.shop rows have **"Conversion By" blank** — correctly, nobody converted a
website checkout. Rather than invent a "Website" user and put 156 orders of incentive credit on
someone who never made a call, 023 makes `original_owner_id`/`current_owner_id` nullable for
`is_legacy` rows only. NULL owner already means "unassigned" everywhere else in this schema
(`leads.owner_id` is nullable; D-020 masks phones for exactly these rows), and these 156 unassigned
orders are the natural pool for the RRR assign feature the user asked for. Non-legacy orders keep
the old guarantee via `orders_live_needs_owner`.

### D-064 · 2026-09-09 · The team's real call log imported; `order_placed` added as an outcome
Imported the "AI Daily Queue" tab — 1,769 logged follow-up attempts on 819 customers over 44 days
(24 Jul – 8 Sep 2026) — into `followups` as `kind='order'` rows parented on the customer's own
order (`followups_one_parent` requires exactly one parent, and these are retention calls on people
who already bought). `scripts/import-ai-queue.mjs`; re-runnable, deduped on the queue's own natural
key (Selection Date + Customer Key) held as a COUNT so a legitimate second same-day call is kept.
**Migration 024 extends `followups.outcome`.** The sheet's dropdown has nine values; the schema had
six, and `Order Placed` (182 rows) had no home. Folding it into `will_buy` would have merged "he
says he'll buy" with "he bought" — destroying the single number the whole RRR programme is measured
on — so `order_placed`, `medicine_not_finished` and `will_update_later` were added. The mapped
outcome is a summary only: every row also keeps the operator's exact words in `remark`.
**Two source defects found and reported, not silently absorbed:** 84 rows written on 2026-08-03 by
an older version of the Apps Script have their fields in the wrong columns, and 8 of those carry a
Source Row number (1699–1744) where the attempt count belongs — numeric, so a naive check passed
them and they reached the database as `attempt_no = 1734` before being caught and removed. Both are
rejected as `column_shifted_source_row` now.
Final: 1,572 follow-ups, 197 rejected. Result visible immediately: conversion by rep runs
Ashutosh 17.3% / Shreyansh 7.2% / Tejasv 4.7%, and **53% of all calls are never picked up** —
the largest operational finding in the data.

### D-065 · 2026-09-09 · RRR tab, and the auditor's one narrow write
User: "here must be a tab of rrr like in alka and coo and shivansh they can see all rrr list and
after that according to data they can tick and send the leads to sales person or assign them."
Migration **025** adds `v_rrr_queue` (security_invoker, so each viewer sees only what their own RLS
allows) and `fn_assign_rrr_customers(uuid[], uuid)`. New route `/rrr`, in the nav for
auditor/coo/admin/ceo/sales_manager only — a sales exec works their own queue on Today; this screen
is for deciding who works which repeat customer.
**The auditor conflict, resolved deliberately.** Alka is an `auditor`: read-everything,
write-nothing (D-012/013), whose own migration comment said giving that role write access "would
make the audit trail lie about who looked at what". The user was shown this conflict and chose to
let her assign anyway. Rather than widen the auditor's write surface across every table, this is a
single narrow hole: one SECURITY DEFINER function, one field, permission re-checked in the body,
and the existing customers audit trigger records who did it (`auth.uid()` still resolves to the
real caller inside a definer function). Alka still cannot touch an amount, an outcome or a stage.
`scripts/test-rrr-assign.mjs` proves it against real impersonated JWTs, the way PostgREST connects:
15 assertions covering who may assign, who is refused, what may be assigned to whom, and the side
effects — 15/15, plus the existing 27 RLS tests still green.
**Assignment moves open follow-ups too**, or the new owner inherits a queue they cannot see.
Completed follow-ups keep their original owner: who made a call in the past is history, not state.
**Two things the data forced.** (a) `customers.segment` is NULL for the entire imported base —
it is measured from `course_ends_at`, which needs a dispatch date no legacy order has (D-062) — so
the view computes `rfm_segment` alongside it, using the ladder the team already reads daily on
their own dashboard (orders + recency, same A1..C2 labels). Two definitions of one set of codes is
a wart, recorded here rather than resolved by quietly redefining PROJECT.md's column. (b) Only
2 of 11 sales_exec accounts and 0 of 5 doctors are active, so the assign dropdown offers exactly
Ashutosh, Tejasv and Shreyansh — which matches the three reps hardcoded in the team's Apps Script.

### D-066 · 2026-09-09 · Logging a call — the gap that was keeping the sheet alive
User: "ab mujhe pehle wale dashboard pe zyada kaam nahi karna, ye new system hum bana rahe hain
ispe hi kaam karna hai." Checking what that actually requires turned up the blocker: the app could
edit a follow-up's free-text `remark` and **nothing else** — no outcome, no completion, no next
date. The single action the floor performs dozens of times a day (their form: outcome, who
attended, which business number, note, next date) did not exist here at all. Until it did, the
team could not stop using the Sheet no matter what else was built.
Migration **026** adds `contact_numbers` (the four numbers from their own `FOLLOW_UP_NUMBERS`, as a
lookup like every other fixed list, not free text) plus `followups.contact_number_id`, and widens
`v_rrr_queue` with `open_followup_id` / `last_order_id`. `outcome`, `completed_at`, `next_due_at`
already existed (005, 024).
**Works both ways round, because the floor does:** against a scheduled follow-up, or against a
customer a rep just decided to ring — 618 of the 1,769 rows in their own log are that second kind
("manual_follow_up"), so a call with nothing scheduled creates its own record, parented on the
customer's last order.
**No SECURITY DEFINER.** `followups_write` already grants a user their own rows, so RLS is the
check and a caller without permission updates zero rows — reported, never swallowed as success.
`scripts/test-log-call.mjs` proves it: a rep can log their own call and schedule the next; another
rep cannot log or even see it; **the auditor cannot log a call at all** — D-065's assignment hole
stayed exactly one hole; and outcomes outside the allowed list and parentless follow-ups are both
refused. 8/8, alongside 15/15 RRR-assign and 27/27 RLS.
**`/rrr` opened to sales_exec too.** It was oversight-only, but the people who make the calls are
sales execs — they could not reach the screen. RLS already limits them to their own customers, and
the assign controls are a separate permission checked in the database, so widening the nav costs
nothing and gives each rep their own repeat list.
**Still missing before the Sheet can actually be switched off:** the same log-call action is not
yet wired into Today (`ModuleGrid`), which is where reps start their day; nothing syncs the Sheet
after this one-time import, so a cutover date is needed rather than parallel running; and the
Apps Script column-shift bug from 2026-08-03 is still unfixed in the live script — irrelevant if
the Sheet is retired, corrupting if it is not.

### D-067 · 2026-09-09 · Segment removed; customer history added; three import bugs fixed
User: "Alka ke paas kuch is tarah se screen aani chahiye RRR orders wali, aur usko open kare to
uski order history and followup history. I think ye segment wali cheez is just a confusion so
completely remove that." Migration **027** rebuilds `v_rrr_queue` without any segment column and
adds `v_rrr_customer_orders` / `v_rrr_customer_followups`. Removing it also retires the wart D-065
recorded: `segment` meant one thing in PROJECT.md and another on the team's dashboard under the
same A1..C2 labels. `customers.segment` itself is untouched — this changed a screen, not anyone's
data. The list now carries what the team actually reads: payment profile, AOV, days since order,
activity, and follow-up state; opening a row shows every order (with products) and every call.
**Three real defects surfaced while checking the numbers against the user's own screenshot, all
fixed by `scripts/fix-import-artifacts.mjs` (dry-run by default):**
1. **172 duplicate orders.** The July "Medicine Order Record" import and the KM002 Master Sheet
   cover the same July 2026 orders. The two copies carry different fields — July has address,
   courier and payment mode, KM002 has the order source — so they were merged (source copied onto
   the July row, follow-ups re-pointed, then the duplicate deleted), not simply de-duplicated.
2. **149 follow-ups with an outcome but no completion.** Their sheet recorded a status with no
   timestamp, so they imported as pending work that was already done, inflating the queue. An
   outcome is proof the call happened; the queue date is the only date the source offers.
3. **Every lifetime value understated by about a tenth.** `orders.amount` is gross in this schema
   (`orders_discount_not_over_amount` only makes sense that way) and `lifetime_value` is
   `sum(amount - discount)`, but the sheet's "Order Amount" is already net. Proof rather than
   assumption: sheet row 1209 has amount 499 and discount 500, impossible if amount were gross.
   Discount is zeroed on legacy rows so `amount` means one thing table-wide. The discount figures
   are **not preserved** in the database; they remain in the source sheet and in data/incoming.
Verified against the user's own dashboard afterwards: Nitin 13 orders ₹45,685, Guruprasad 10 /
₹43,958, Ankit 9 / ₹36,911 — order counts and values now match exactly.
