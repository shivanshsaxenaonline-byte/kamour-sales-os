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

## 2026-09-16 · The All-customers assign reached nobody

Alka ticked leads on RRR > All customers, assigned them, and nothing happened: the row did not
change and the rep's login stayed empty. Not a permission failure — the action worked and meant
nothing. `fn_assign_rrr_customers` moves `customers.current_owner_id`, and since the 14 September
cutover a rep's day is `rrr_work_items` alone, with the restrictive `sales_rrr_customers_only`
policy hiding every customer they hold no open task for. Owning a customer had quietly stopped
showing them anything. Her other three RRR screens (AI, Due today, Medicine Ending) all assign
calling tasks and were working correctly the same morning — 36 handovers that day, verified as
visible to Tejasv, Shreyansh and Ashutosh under their own RLS.

- `fn_assign_rrr_customers_with_work` does both halves in one action: ownership as before, plus
  the calling task, as a `due` item against the customer's open order follow-up. Back to the pool
  withdraws the task with it. No role check of its own — it delegates to the two functions it
  calls, so it cannot become a second, looser way in.
- DND, merged, and customers with no order row are counted out of the task half and reported
  back, rather than one such row raising and failing a batch of fifty.
- The All list now shows who is holding the call and strikes the row through until they log it,
  which is what "sticking" meant. It reads the open tasks behind the fifty rows on the page, not
  the whole table.
- Over 100 selected asks first. The screen can select all 1,349 matching; the whole floor's daily
  AI list is 45.
- 10 new proofs in scripts/test-rrr-assign.mjs, including the one that matters — the rep sees the
  leads on their own list. 24 passed, 1 failed.

**Pre-existing, not fixed:** two failures that reproduce with this migration reverted —
`the auditor's assignment is recorded in audit_log` (test-rrr-assign) and `manager sees only own
assigned Medicine Ending task` (test-rrr-work).

## 2026-09-16 · A handover was arriving with the last rep's call already on it

Alka reported the Due today section: assign a lead and the row does not strike through, and it does
not look like it reached the rep. The first half was real and had one cause.

Most leads on Due today already have an open work item — the rep called yesterday, got no answer,
and the follow-up came back round. Assigning one of those upserts onto the open row, and the
ON CONFLICT list moved `assigned_to` but left `last_outcome`, `last_called_at` and `due_on` as the
previous rep left them. The Due screen strikes a row through only while a task is waiting for its
call (`!!assigned_to && !task_called`), so an inherited outcome made it look already-called the
instant it was assigned. 23 of the 64 open due tasks were in that state; 26 of 75 due rows showed
no strike. Now 72 of 75 strike, and the three that do not have a genuine call logged since their
handover.

- `fn_assign_rrr_work` resets the task on a re-handover: due today, no outcome, no call time, no
  medicine days. Call history is untouched — it lives in `followups`, and always did.
- The same inheritance could park a just-assigned lead in the rep's Upcoming tab, because an
  inherited future `due_on` fails the `due_on <= today` test on /rrr/my. Fixed by the same reset.
- Backfilled the 23 live rows whose call predates their handover. Due dates left alone: every one
  was already due, and moving a rep's dates is not a migration's business.
- Three new proofs in scripts/test-rrr-assign.mjs. 27 passed, 1 failed (the pre-existing audit_log
  attribution one).

**Not reproduced:** the second half. Every open task is visible to its rep right now — Ashutosh
33/33 and Shreyansh 37/37 in Aaj ke calls, Tejasv 30 today and 16 in Upcoming, all sixteen dated
forward by his own calls yesterday. Nothing is hidden. If a rep still reports a missing lead, it
needs the rep's name and the customer to trace.

## 2026-09-16 · WATI Interested: no strike-through, and the name was not a link

Two gaps on `/leads/wati-interested`, both reported by Alka, both on the screen rather than in the
data — the two live hand-overs are correct rows, assigned to Tejasv and never called.

- **No strike-through.** The Interested table is razorpay.css's, not the records table's, so it
  never carried `.record-row.assigned-waiting` and had no strike rule of its own. A row is now
  struck through while a hand-over is waiting for its call — `work && !completed && !lastOutcome`,
  the same condition the RRR lists use, written out in wati-interested.css. The checkbox, the
  calling-status cell and the actions stay readable.
- **The name did nothing.** `displayName` was plain text in a `<td>`; details opened only from the
  "Open details" button at the far right of a ten-column row. The name is a button now, and opens
  the same panel. The button stayed.
- Same reset as RRR (20260916091500) applied to `fn_assign_wati_work`: it already pulled `due_on`
  back to today on a re-hand-over but kept `last_outcome`, `last_called_at` and
  `medicine_days_left`. Nothing live was in that state — this closes the door before it is. Two
  new proofs in scripts/test-wati-work.mjs; all checks pass.

Deployed `kamour-sales-bvfueqxfd`; the production alias resolves to it.

## 2026-09-16 · A call nobody picked comes back in three days, not tomorrow

The floor's rule, applied to both routes a missed call can return by, so it comes back on the same
day whichever one brings it.

- The Log-call dialog pre-fills "Agli follow-up date" with today + 3 instead of today + 1, and the
  button hint reads "3 din baad dobara try". Still a pre-fill, not a rule: `no_answer` is one of
  the outcomes where the rep may choose another date, or clear it and close the task. Only
  Interested (+1), Medicine not finished (the day it runs out) and Baat hui / Baad mein batayenge
  (a date is required) are enforced in the database.
- `fn_generate_ai_daily_leads`: `v_retry_gap` 1 → 3. The 14-day retry window and the 3-attempt cap
  are unchanged — three days apart, three attempts still fit inside the window.
- Effect on tomorrow's list: 33 customers whose call was missed one or two days ago are deferred to
  their third day. From day three onward nothing changes; 91 customers in the window are untouched.
- This also puts the app back in step with the sheet the floor worked from before the cutover,
  which left three days between attempts — every one of the 1,110 imported not-picked calls carries
  a three-day gap. The app had been the odd one out at one day.

Deployed `kamour-sales-e2iym26mb`.

**Already-scheduled rows.** 35 open follow-ups had been dated by the old one-day rule for
tomorrow; they now fall three days from the call that was missed, which puts 33 on the 19th and
leaves 2 on the 17th (their missed call was older). The 33 matching work items moved with them, so
the rep's list and the follow-up agree. Today's 13 were deliberately left where they are — the reps
are working that list right now, and pulling leads out from under them mid-day buys nothing.

Not touched: 16 work items whose due date already disagreed with their open follow-up, some by
months. Those are older import artefacts, not this change, and realigning them would have dragged
July dates into today's calls. Worth looking at separately.

## 2026-09-16 · The calling-number field opens on the rep's own handset

`Kis number se call hui?` opened on 7217399285 for everyone, on every screen, because the dialog
seeded itself with `numbers[0]` and the list is ordered by sort_order. That is Ashutosh's usual
number and nobody else's. Two of the three reps were correcting the field on every call, and the
ones they forgot are recorded against a number they never dialled.

- `fn_my_calling_number()` returns the number the caller last called from — their last fifty
  follow-up calls and last fifty WATI calls, most recent first, ties going to the one they use more
  often, deactivated numbers never suggested. SECURITY DEFINER because a rep's own history sits
  behind `sales_rrr_followups_only` and they would otherwise see almost none of it; it returns one
  contact-number id and nothing else.
- Last used, not most used. The floor moves between handsets within a day, not over months: Tejasv
  has 394 lifetime calls on 9045599289 and 203 on 7217399285, spent last week on the second and is
  back on the first today. A lifetime count would have pinned him to the wrong one all day.
- Verified per rep against their actual last call: Tejasv 9045599289, Ashutosh 7217399285,
  Shreyansh 9045599289. Someone with no history still falls back to the first in the list.
- Threaded through the three screens that open the dialog: /rrr/my, RRR All + AI, Medicine Ending.
  Still only a default — the select is the rep's to change, and what they pick is what is recorded.

**Two stale checks in scripts/test-rrr-work.mjs, fixed.** Its "no work yet" cleanup marked the
reps' live tasks complete but skipped the manager entirely, so the four "unassigned manager" probes
started failing the moment Alka handed Ashutosh his first Due-today lead. And completing a task no
longer hides it: 20260915063256 widened `rrr_work_read` so a rep can still see their own tasks
completed today, which is what the day's progress bar counts, so the cleanup left the work visible
and the probe read it back. It now clears the call time too, and covers the manager and
wati_work_items. The suite is green for the first time today — including `manager sees only own
assigned Medicine Ending task`, which I had been reporting as a pre-existing product failure since
this morning. It was the test, not the policies.

Deployed `kamour-sales-69utem1pi`.

## 2026-09-18 · "Other", for the call the eight buttons could not hold

**The floor had no word for half of what customers actually say.** Shifted city, in hospital,
family function, asking for a different product, call me after the festival. The Log-call dialog
offered eight outcomes and none of them fitted, so a rep picked the least wrong button and typed
the truth in the note. The outcome column then said "Baat hui" or "Baad mein batayenge" about
calls that were nothing of the sort, and every count built on that column inherited the lie.

- A ninth button, `other`, with two rules that make it safe to offer. The note is compulsory —
  an "Other" with nothing written is the very problem it exists to fix. And the next follow-up is
  tomorrow, fixed, exactly like Interested: whatever the customer said has to be read by somebody
  the next morning rather than kept in one rep's head.
- Enforced in all three places a call can be logged, not just in the dialog: the server action, the
  assigned-RRR RPC and the WATI hand-over RPC. `followups_outcome_check` gained the value; the two
  functions gained the note and next-day rules. A rep who reaches the RPC another way gets the same
  refusal the dialog gives.
- It counts as a connected call in the RRR and WATI analytics tiles, because the dialog will not
  accept one without a note describing the conversation.
- `scripts/test-other-outcome.mjs` proves it end to end on live schema, all writes rolled back: an
  empty note refused, a date that is not tomorrow refused, no date refused, and after a good one the
  task stays open due tomorrow with an open follow-up waiting — so the customer is back in Action
  due the next day, which is the whole point.

Deployed `kamour-sales-mcc6bkgfk`.

## 2026-09-18 · A fifth number in `Kis number se call hui?`

9045599290 is on the floor but was not in `contact_numbers` — 026 seeded the four that were in the
team's Apps Script and nothing has been added since. A call from the new handset therefore had no
honest answer in the dialog: the rep picked a number they had not dialled, and a customer who rings
that number back reaches somebody else.

- Seed data, not schema. Verified through RLS as a rep: the select now offers all five, in order.
- No deploy: every screen that loads the list is `force-dynamic` (and the All/AI screen reads it in
  the browser), so the number was selectable in production the moment the migration applied.
- The down file deactivates rather than deletes — `followups.contact_number_id` points here, and a
  past call must keep naming the handset it went out from.

## 2026-09-18 · An order the sheet never confirmed is not an order

**Seven customers who never confirmed were sitting in the calling lists, and three had already**
**been rung.** The Medicine Order sheet says so twice and the app was reading neither: the tick in
`Pending Status` on the main tab, and a Cancelled row in `Pending Confirmation Medicine Order -
AP+TA+SS`. The tick was imported as `stage = pending_confirm`, which nothing filtered on —
`v_rrr_queue` asks only for `lifetime_orders > 0`, and an unconfirmed order counts.

- The sync now refuses those rows outright, and removes the order if one already exists. That
  second half is the important one: the floor ticks the row *after* the order has been entered, so
  a row that turns pending has to take its order with it. `fn_discard_sheet_order` does the
  removal — the order cascades to its items, follow-ups and sheet link, and the RRR task is deleted
  first because `rrr_work_items.order_id` has no cascade.
- The tick is read before the phone check, not after. Nikhil's pending row had lost its number, so
  the first pass turned it away as `missing_or_invalid_phone` and left his order behind.
- Cancelled rows are matched on customer + day + amount, never on the phone alone. Nitin cancelled
  once in June and has twelve real orders; Devendra cancelled in April and bought in July. Matching
  by phone would have thrown both away. Five cancelled orders were in the base from the legacy
  import with no row in the July tab at all, so the sync also resolves the holding pen against the
  database directly.
- The customer row stays. All eight who lost their only order have a lead or a consultation from
  another sheet, and deleting the customer would take that with it — and the consultation sync
  would recreate them anyway. With no orders their `lifetime_orders` rolls to zero and
  `v_rrr_queue` drops them, which is what the floor sees.
- Twelve orders removed, verified against a backup taken first: six ticked, one ticked-and-phoneless,
  five cancelled. Sankhadeep keeps his real delivered order and stays callable on that one.
  `scripts/test-unconfirmed-orders.mjs` re-reads both tabs and asserts it, and
  `scripts/import-sheets.mjs` rejects ticked rows too so a re-run cannot put them back.

## 2026-09-18 · Medicine Ending stops offering people who were called yesterday

The screen listed every delivered course by days remaining and said nothing about whether anyone
had already rung. A customer called yesterday morning was still at the top of the list today,
which is how the same person gets asked about the same course twice in two days.

- Anyone with a call logged since yesterday 00:00 IST is out of the list. Two days, not one: the
  floor works this screen in the morning, and yesterday's conversation is still the current one.
- Three sources, because a call can be logged three ways: `followups` (every RRR call, from any
  screen), `rrr_work_items.last_called_at`, and `wati_work_items` — a WATI hand-over writes no
  follow-up, since its prospect has no order to hang one on.
- If any of those reads fails, nobody is excluded and the page still loads. Hiding the whole list
  would be worse than showing a few finished rows.
- On today's data it takes the screen from 23 rows to 11 in the −7/+3 day window.
  `scripts/report-medicine-ending.mjs` prints that window split into overdue / due today / coming
  up, and marks who is hidden and why.

Deployed `kamour-sales-hjd39zh73` and `kamour-sales-623g14iws`.


## 2026-09-19 · The dialog can finally say the customer bought

**`order_placed` has been a stored outcome since 024 and the dialog never offered it.** It is the
single number the RRR programme is measured on — *he bought*, not *he says he will buy* — and a rep
whose call ended in an order had to pick "Interested" and write the truth in the note. That is the
same defect `other` was added to fix, on the outcome where it costs the most: every such call was
counted as a promise and came back in the queue the next morning.

- **No next date, and the task closes.** The new order is what raises the next call — Medicine
  Ending sees the new course running out. A follow-up booked here would put the customer back on a
  list this week about the course they have just replaced, which is the call the floor stopped
  making yesterday. The server refuses a date rather than ignoring one.
- **The note is compulsory**, like `other`'s. This is a claim about money made by the person
  credited for it, hours before the Medicine Order sheet can confirm it, so it has to say what was
  ordered. `scripts/report-order-claims.mjs` re-reads the claims against the orders that actually
  arrived: over the whole history, 27 real claims, 21 confirmed, 6 with no order — the two most
  recent are Shreyansh's. Sheet rows the import wrote about an order that already existed
  (`Automatically marked converted`, `Course follow-up scheduled from delivery`) are not claims and
  are left out, the same two the customer timeline hides as not-a-call.
- **A WhatsApp order clears the customer's RRR task too.** `rrr_work_one_open_customer` allows only
  one open RRR task per customer, so an RRR order has no sibling to clear — but a WATI hand-over is
  a second list, and the customer who just ordered on WhatsApp is the one the medicine-ending task
  was about. Only tasks nobody has worked (`last_outcome is null`), deleted rather than completed,
  exactly as `scripts/close-reordered-medicine-tasks.mjs` does it.
- The timeline still reads a rep's claim as "Rep noted: ordered" rather than a confirmed sale, and
  the RRR analytics count it as the conversion it claims to be. `scripts/test-order-placed.mjs`
  proves all of it against the live schema, writes rolled back — including that a rep loses sight
  of the follow-up the moment the order closes their task, which is `sales_rrr_followups_only`
  doing its job.

Deployed `kamour-sales-bzd2f4zvk`.


## 2026-09-19 · The order books the call its course earns

"Order placed" closes the task and books nothing, which was right — on the day of the call nobody
knows what the customer just bought. The Medicine Order sheet knows a day later. **So the order
schedules the call now, not the rep.** An order that answers an `order_placed` claim raises the
open follow-up itself, dated from the course it carries.

- **The date:** delivery date + course days when the sheet has a delivery date; order date + 6 +
  course days when it does not; three days early either way, never earlier than tomorrow. The six
  is measured, not guessed — the median order-to-delivery gap across the 147 deliveries on record
  (p90 is 11). It matters because only 148 of the 583 orders in the last six months are ever marked
  delivered: waiting for a delivery date that never comes would leave three out of four orders
  without a call. When the delivery date does arrive later, the same trigger moves the call it
  already booked; when the parcel comes back or the order is cancelled, it takes the call away.
- **`orders.next_followup_at` finally means something.** It has been a generated column since 004 —
  `(dispatch_date + course_duration_days) - 4` — and nothing has ever written `dispatch_date`,
  because the sheet has no such cell: **null on all 2,037 rows**, in a column whose name promises
  the answer. That is also why a trigger could not fill it; assignments to a generated column in a
  BEFORE trigger are silently discarded, which cost an hour before the column definition explained
  itself. It now carries the same expression the follow-up uses, so the order and the call it books
  cannot disagree, and `v_orders_list` (the CRM orders grid, which already had the column and sorts
  by it) was recreated over it with its grants unchanged.
- **Only claimed orders.** A rep's own `order_placed` call within 21 days before the order date and
  7 after — not the 184 rows the old sheet import wrote *because* an order already existed, the
  same two remarks the customer timeline hides as not-a-call. Every other order stays the AI list's
  and Medicine Ending's business rather than being duplicated for the whole base. And when a
  customer already has an open call, this one is not stacked behind it.
- **23 calls backfilled** for orders that synced before any of this existed —
  `scripts/backfill-course-followups.mjs`, dry-run by default. Fifteen of those orders were never
  marked delivered, so Medicine Ending could not see them at all: the customer had bought, their
  course was ending, and nothing was waiting on anyone's list. The first run booked them a day
  early — `date` comes back from Postgres as UTC midnight and reading it back in IST moves it —
  so the script now computes every date in SQL and re-dates what it finds.
- `scripts/test-order-books-call.mjs` proves the lot against the live schema, writes rolled back,
  and `scripts/test-rls.mjs` still passes over the recreated view.

Deployed `kamour-sales-2e7bwngv9`.


## 2026-09-21 · A banner that is always on is not a signal

The Today queue opened on **SLA breach**, rank 1, painted red: a lead not yet contacted past its
`sla_due_at`. All 67 rows in it this morning were the same thing — unpaid `zoho_legacy` leads.
Migration 014 gave the column a default of `now() + 15 minutes`; 018 nulled it for the legacy
backfill, but the live Zoho sync keeps writing fresh rows that take the default and breach a
quarter of an hour later, with nobody ever intending to call a sync insert inside fifteen minutes.
**So the bucket comes out of the queue.**

- The `sla_due_at is null or sla_due_at >= now()` guards came out with it. They were 017's work,
  stopping a breached lead appearing in two buckets; with no breach branch left they would have
  hidden those 67 leads entirely rather than de-duplicated them. An uncontacted lead now lands in
  `paid_lead` or `unpaid_lead` on its merits. Counts before and after: 67 + 15,960 unpaid became
  16,027 unpaid, queue total unchanged at 16,145.
- **Nothing dropped.** `leads.sla_due_at` keeps its column, default and index, and the app keeps its
  `sla_breach` label and red styling, so the down migration restores the old queue by itself.
- `scripts/test-rls.mjs` passes over the recreated view, 27 of 27.


## 2026-09-21 · A call already booked is not a fresh task

Tejasv reported that marking **"medicine khatam nahi hui"** did not take the customer off his list
and did not move them to Upcoming. The write path turned out to be sound — a dry run of
`fn_log_assigned_rrr_call` as Tejasv, rolled back, parked the task correctly and closed its
follow-up — so the outcome was not being lost when it was saved. **It was being erased afterwards.**

`fn_assign_rrr_work` resets a re-assigned task to due-today with no outcome (20260916091500: a
handover is an instruction to call). Medicine Ending suppresses a customer for two days. So Tejasv
rang Shrikant on the 16th, was told nine days of medicine were left, and the call booked the 25th;
on the 18th Shrikant was back on Medicine Ending, went out in the morning's assign batch, and the
reset pulled him to due-today with `last_outcome` and `medicine_days_left` wiped. The rep saw
"Not called yet" on a man he had marked two days before. **Six tasks were in that state, three of
them Tejasv's.** All six rebuilt from `followups`, which had the calls all along.

Five things changed:

- **`fn_assign_rrr_work`** keeps `due_on`, `last_outcome`, `last_called_at` and `medicine_days_left`
  when the task it is overwriting has been worked and its date is still ahead. A task due today or
  overdue resets exactly as before, so 20260916091500 keeps the case it was written for.
- **Medicine Ending** no longer lists a customer whose next call is already booked for a later day.
  Two days of silence is the right rule for "we spoke"; it is the wrong rule for a promise with a
  date on it.
- **`fn_log_assigned_rrr_call`** closes the customer's open follow-up whichever order it hangs on,
  and closes any sibling with it. Matching on customer **and** order meant a task attached to the
  newest order could not close a follow-up sitting on an older one: the call opened a second row
  beside the first and nothing could ever close either. Eight customers were carrying one — ANAND's
  was dated 26 July while his task was parked to 14 Nov, which kept him reading as overdue on Due
  today where he could be assigned all over again. 42 such rows closed; open `order` follow-ups
  dated before today fell from 113 to 15, and no customer has two any more.
- **Today is no longer a valid next-call date.** The pickers for "Baat hui", "Baad mein batayenge",
  "Call not picked" and "Not interested" all started at today, and a task dated today by the call
  that just ended was called-today *and* due-today: out of Aaj ke calls for having been called, out
  of Upcoming for not being later, and so off the rep's screen until tomorrow. Refused in the dialog,
  in `logCall`, and in both database functions.
- **The two tabs are a partition.** Upcoming is now "everything not in Aaj ke calls" rather than
  `due_on > today`, so no task can fall between them whatever date an older row carries; a called
  row still dated today reads "Called today". The just-saved set is also applied to the search and
  cleared when the refreshed rows land — a rep who saved a call while searching used to watch the
  row sit there unchanged, which is exactly what "I marked it and nothing happened" looks like.

Verified on the live database: all three migrations rehearsed in a rolled-back transaction first,
then applied; re-assigning Shrikant now leaves 25 Sep and his nine days intact, an unworked task
still resets to due-today on handover, and a call booked for today is refused. Tejasv's Aaj ke
calls went 27 → 21, Upcoming 40 → 46, nothing stranded. Types and production build clean.
Backup `backups/2026-09-21T11-03-27` taken before the data repairs. Deployed
`kamour-sales-lvtsa42ro`.

**Not verified:** the rendered page. As on the 19th, the local dev login picker is not configured,
so the React render path for `/rrr/my` and Medicine Ending is reasoned from the code and the data,
not seen.


## 2026-09-21 · A reorder is an order placed

Following on from the fix above: order_placed only ever got written when a rep logged it during a
call. A customer who reorders on their own — website, Zoho, ops re-entering a WhatsApp order —
left no trace anywhere in the outcome trail. The only place the system even noticed was
`hasReordered` on Medicine Ending, and all that does is drop the row from the list; it credits no
rep and closes no task. **320 customers have reordered. Only 55 had an order_placed call on record
for any of it.**

Two changes, scoped to when there is an open task to close — a customer nobody was tracking is not
this migration's business:

- **A trigger on `orders`.** When a reorder lands (not the customer's first, not rto/cancelled) and
  the customer has an open RRR task, the task closes as `order_placed` — same shape as a rep
  logging it, credited to whoever was holding the task, no next date (order_placed still ends the
  chain). Every other open repeat-order follow-up on that customer closes with it, same reasoning
  as the follow-up fix above. The row it writes carries the same "Automatically marked converted"
  marker the 004 sheet import used, so the customer-panel timeline folds it into the order rather
  than showing a fabricated call, and it deliberately sits outside `fn_order_books_next_call`'s
  claim window — a silent reorder is not a rep's prediction of one; Medicine Ending picks the
  customer back up once the new course is the one running low.
- **A one-time backfill.** Every reorder with no order_placed claim within the same
  21-days-before/7-days-after window the live system already uses to match a rep's call to the
  order it produced — 626 rows, dated to the order it belongs to. order_placed customers went 55 →
  379.

Verified: the trigger rehearsed against a rolled-back transaction first — closing an open task on a
real reorder, leaving a customer with no open task untouched (0 marker rows before and after), and
writing nothing for a customer's first order. Then applied for real: 626 backfilled, trigger
installed, zero work items left completed-but-still-marked-open. Backup
`backups/2026-09-21T11-33-48` taken first.

Left alone deliberately: `hasReordered` on Medicine Ending stays exactly as it was. It answers a
different question — which of a customer's several orders is the one still in play — and is
unrelated to whether the conversion gets credited.
