# PROJECT.md — Kamour Sales OS

Internal sales CRM desktop app. Ayurvedic men's wellness brand, Bareilly UP.
Replaces: Zoho CRM + 9 Google Sheet tabs + WATI + manual Razorpay checks.
Users: 3 sales execs, 1 manager, doctors, COO, CEO. Scaling to ~15.

---

## STACK (locked — do not substitute)

| Layer | Choice |
|---|---|
| DB / Auth / Realtime | Supabase (Postgres, RLS, Realtime) |
| Frontend | Next.js 15 App Router + TypeScript strict |
| UI | Tailwind + shadcn/ui |
| Grid | TanStack Table + TanStack Virtual |
| Server state | TanStack Query |
| Desktop | Tauri v2 — `.exe` |
| Web host | Cloudflare Pages (NOT Vercel — Hobby bans commercial use) |
| Files | Cloudflare R2 (NOT Supabase Storage — saves quota) |
| Webhooks | Supabase Edge Functions (Deno) |
| Errors | Sentry free |

**Not in scope:** telephony, call recording, Vercel, any LLM call in Phase 1.

Everything above is free tier except Supabase Pro ($25/mo) at launch.

---

## HARD CONSTRAINTS

### 1. Egress is the binding limit
Measured on an existing project in this Supabase org: **184 MB/day with 4 users** against a
**5 GB/month** free limit, pooled org-wide. A 15-user CRM breaks this in days.

Rules, not suggestions:
- Never `select *`. Name columns explicitly.
- Every list paginated, default 50, range queries only.
- List views fetch summary columns; full record loads on row expand.
- Realtime subscribes to **filtered** channels (own rows), never whole tables.
- Zero polling. No `setInterval` fetching. Use Realtime.
- Log measured egress in `docs/egress-log.md` after each phase.

### 2. No AI in Phase 1
Dropdowns, SQL formulas and webhooks only. Team must trust the data first.
When AI arrives (Phase 3) it produces a **draft** in a highlighted field that a human
confirms before save. AI never writes directly.

### 3. These fields are never auto-filled, ever
`address`, `pincode` (one wrong char = RTO = money lost) · `amount`, `discount` (money) ·
`order_items`, `quantity` (this is a prescription) · `course_duration_days` (the RRR clock).

`next_followup_at` is a SQL formula, never AI: `dispatch_date + course_days - 4`.

---

## DESIGN SYSTEM

This is an 8-hour-a-day operations tool, not a landing page. Density and calm over decoration.
Reference feel: Linear, Height. Not: generic shadcn dashboard demo.

**Target feel (updated 2026-09-08, D-054):** modern, professional, premium — Linear, Height,
Vercel, Raycast. Premium through typography, spacing rhythm, colour discipline and considered
states; **never through decoration, and never at the cost of density.** Modern does not mean
airy: 32px rows and 20+ rows on a 13" laptop still hold.

**Rejected by default:** gradient headers, glassmorphism, oversized hero numbers, decorative
icons in every cell, card grids where a table belongs, purple-blue SaaS gradient, emoji as UI.

### Tokens
The palette below is the *current* implementation and is open for replacement — the design
agent has been asked to propose a better one keeping this structure (one accent, three semantic
pairs, light + dark, WCAG AA). See `docs/astra-prompt.md`.

```css
--bg:        #F7F8FA;   /* app background */
--surface:   #FFFFFF;
--border:    #E3E7ED;
--border-str:#C9D1DB;   /* table rules, focus */
--text:      #1A2231;
--text-dim:  #667080;
--accent:    #1E5EFF;   /* single accent. selection, focus, primary button */

/* semantic — these map to real business states, use nowhere else */
--paid:  #0E6B57;  --paid-bg:  #DCEFE9;
--pend:  #9C5F14;  --pend-bg:  #F7EAD6;
--stop:  #96292A;  --stop-bg:  #F5DEDE;
```

Dark mode: same tokens inverted. Ship it — sales floors run late.

### Type
- UI: Inter or Public Sans. 13px base (dense tool, not 16px marketing).
- **All numbers, IDs, dates, phones: `font-variant-numeric: tabular-nums`.** Non-negotiable —
  columns must align vertically when scanning.
- Weights: 400 body, 500 labels, 600 headings. Never 700 in tables.

### Density
- Table row height **32px**. Header 36px. Cell padding `6px 10px`.
- A 13" laptop must show 20+ rows without scrolling.
- Status = a small text pill, not a coloured row background. Coloured rows destroy scanability.

### Interaction (this is what makes it feel expensive)
- Keyboard first: `j/k` row nav, `Enter` open, `e` edit, `/` search, `Esc` close, `Ctrl+K` command palette.
- Optimistic updates — UI moves instantly, server confirms after, rollback + toast on failure.
- Zero full-page spinners. Skeleton rows only.
- Every destructive action undoable for 10s via toast, not a confirm dialog.
- Transitions ≤150ms or none. Respect `prefers-reduced-motion`.

### Language
**English throughout** (changed 2026-09-08, D-053 — supersedes the original Hinglish rule).
Code, tables and comments in English too. Lookup tables keep an unused `label_hi` column.

---

## DATA MODEL — core principles

**Golden Customer.** One human = one `customers` row across all channels. Normalize every
phone to E.164 (`+919990434773`); unique + indexed. In the legacy Zoho data "Zaid" and
"Zaid WATI" are two rows for one person — the import must merge these.

**Follow-ups are rows, not columns.** The current sheet has `Follow-up 1..5` columns and runs
out at 5. Table: `followups(due_at, owner_id, outcome, remark, next_due_at)`.

**Order items are rows, not columns.** Current sheet has a column per SKU. Use
`orders` + `order_items`. Adding a product must never require a migration.

**Lookups, not free text.** `lead_sources`, `lead_statuses`, `concerns`, `couriers`,
`payment_modes`, `lost_reasons`. Evidence: the July sheet has `Lead Source = "Follow up"` for
~87 rows — columns physically shifted. Make that class of bug structurally impossible.

**Audit log — only these fields:** `amount`, `status`, `owner_id`, `address`,
`payment_status`, `order_items`. Logging everything eats the quota faster than real data.

### Tables (minimum)
`customers` · `leads` · `consultations` · `prescriptions` · `orders` · `order_items` ·
`followups` · `products` · `users` · `roles` · `attendance` · `assignments` ·
`wa_conversations` · `ad_spend` · `audit_log` · lookup tables

---

## BUSINESS RULES

### Sequence (never changes)
`Lead → Consultation (₹99, doctor call) → Prescription → Order → Follow-up → Repeat`

### Reference numbers (July 2026 — use for sanity checks)
507 consultations (415 done / 84 pending / 8 cancelled) · 163 orders · **70 repeat (43%)** ·
93 new · **142 of 163 orders are 15-day courses (87%)** · Elementor = 75% of leads ·
Payment: Gpay+COD 76, Gpay 62, Razorpay 10 · Delhivery 119, Shiprocket 33 · Zoho legacy 52,072 rows.

**The core problem:** 415 consultations → 93 new orders. ~322 people spoke to a doctor and
vanished. Making them visible and followable is the product's main job.

### RRR clock — auto-created on dispatch

| Course | Response | Mid | **Repeat pitch** | Last chance |
|---|---|---|---|---|
| 7d | D+2 | — | D+5 | D+9 |
| **15d** | D+3 | D+8 | **D+11** | D+17 |
| 30d | D+5 | D+15 | D+24 | D+33 |
| 60d | D+7 | D+30 | D+50 | D+65 |
| 90d | D+10 | D+45 | D+78 | D+96 |

### Segments (nightly cron, days past course end)
A1 0–15 · A2 16–30 · B1 31–60 · B2 61–90 · C1 91–180 · C2 180+

Store `original_owner_id` **and** `current_owner_id`. RRR goes to the original salesperson
first (existing relationship). Moves to pool only after 2 failed connect attempts.
Incentive credit follows `original_owner_id`.

### Roles
`sales_exec` `sales_manager` `doctor` `ops` `coo` `ceo` `admin`

RLS enforced at the database, not the UI. A sales exec must not be able to read another
exec's rows even with a crafted API call. Write tests proving this.

Phone numbers masked (`98••••4773`) for unassigned leads. Bulk CSV export requires manager role.

### Absence handling
Manager marks a rep absent → choose: assign all to one · round-robin split · split by load ·
park in pool. On return, untouched leads revert.

### Products
`Gold Plus` (60N/30N) · `Daily Charge` (60N/30N) · `Power Drive` · `Boost Up Oil` ·
`Shilajit Gold Resin` · combos: `Confidence Combo`, `Starter Combo`, `7-Day Booster Combo`.
Live in a `products` table. Never hardcoded.

---

## MODULES

### Phase 1
| Module | Notes |
|---|---|
| **Today** (was "Aaj Ka Kaam") | Default home for sales execs. NOT a tab — one priority queue across all sources. Phase 1 ranking = SQL `ORDER BY`: SLA breach → paid lead → RRR due → follow-up due → unpaid. |
| **Elementor Leads** | Tabs: Paid / Unpaid / Junk. Paid always above unpaid. Razorpay webhook sets paid — never a manual checkbox. "Order banao" button lives here. |
| **Consultation** | Tabs: Paid / Unpaid / Cancelled / Done today. Cancelled needs a mandatory reason. |
| **Orders** | Tabs: Pending confirm / Confirmed / Dispatched / Delivered / RTO. |

### Phase 2 (schema now, build later)
RRR module · WATI Inbox · Manager Cockpit · absence redistribution · SLA timers · masked phones

### Phase 3
AI draft-fill · voice note via Web Speech API · lead scoring · CEO analyst agent

### Phase 4
Doctor Console (structured Rx → auto cart + PDF + WhatsApp) · `ad_spend` ingestion for CAC

### Grid requirements (all modules)
Inline edit · keyboard nav · bulk select · column show/hide · saved filters · virtualized rows ·
live updates without refresh · soft row lock (10min when a rep starts a call) · presence badge.

---

## BUILD ORDER

**Phase 0**
1. Inspect existing Supabase project (a staging DB with partial data already exists).
   Write `docs/schema-current.md`. **Report before changing anything.**
2. `docs/schema-target.md` → `docs/schema-diff.md`. **Wait for approval.**
3. Migrations (numbered, each with a `down`).
4. RLS policies + tests.
5. Zoho import — **batched**. Supabase forces read-only mode if one load exceeds ~1.5x current
   DB size. Import last 12 months only (~15k rows); archive older to R2 as CSV. Batches of
   5,000 with `VACUUM` between. Merge duplicates during import, not after.
6. `pg_dump` → R2 daily via GitHub Actions. Verify a restore works. **Not optional** — the free
   tier has no reliable backup.

**Phase 1**
Auth + role routing + shell → data layer + reusable virtualized grid → Elementor Leads +
Razorpay webhook → Consultation → Orders → Today queue → Realtime (sync, presence,
row lock) → Tauri packaging → egress optimization pass.

### Definition of done
> A sales executive works a full day without opening Google Sheets.

If they still open the sheet, Phase 1 is incomplete regardless of feature count.

---

## AGENT RULES

1. **Never assume the DB is empty.** Inspect first, report, then propose. No `DROP` without
   explicit approval.
2. **Ask instead of guessing.** Unclear business rule, price, status value, timing — stop and
   ask. A plausible wrong guess is worse than a question.
3. **Small commits.** One migration or one component each.
4. **Record decisions.** Every non-obvious choice goes in `docs/decisions.md` with its reason.
5. **Read this file before each session.** Do not re-derive context from code.

### Division of labour (see docs/decisions.md D-001)
Data model, mapping, migrations, RLS, import and application code: this agent.
UI/visual design: produced externally from `docs/design-brief-for-astra.md`.

---

## REPO

```
kamour-sales-os/
├── PROJECT.md               ← this file
├── docs/                    ← also usable as an Obsidian vault
│   ├── schema-current.md  schema-target.md  schema-diff.md
│   ├── mapping-legacy-to-target.md  design-brief-for-astra.md
│   ├── open-questions.md  decisions.md  egress-log.md  daily-log.md
├── supabase/{migrations,functions}/
├── src/{app,components,lib,types}/
├── src-tauri/
└── .github/workflows/backup.yml
```

---

## START HERE

Do **only** this, then stop:

Connect to Supabase. Inventory every table, column, index, RLS policy, function and trigger.
Write `docs/schema-current.md`. Report:
- tables that exist + approximate row counts
- `pg_database_size()`
- which concepts from DATA MODEL exist vs missing
- anything wrong or surprising

Do not write migrations or UI code yet.
