# schema-target.md — Kamour Sales OS

Target Postgres model for Phase 1, with Phase 2–4 tables created now (schema first, UI later),
per PROJECT.md BUILD ORDER.

Written before `schema-current.md` exists. When the live DB is inspected, this file stays the
target and `schema-diff.md` reconciles the two. **No migration is written until the diff is approved.**

Conventions
- `id uuid primary key default gen_random_uuid()` everywhere. No serial ints exposed to the client.
- `created_at timestamptz not null default now()`, `updated_at timestamptz not null default now()`
  (trigger-maintained), on every mutable table.
- Soft delete only where undo is required: `deleted_at timestamptz`.
- All timestamps `timestamptz`, stored UTC. App renders Asia/Kolkata.
- Money: `numeric(12,2)`. Never float.
- Lookup tables, never enums, for anything the business may add a value to
  (statuses, sources, reasons, couriers). Enums only for things fixed by code paths.
- Every FK column is indexed. Every list view has a covering composite index (see INDEXES).

---

## 0. Enums (fixed by code, not business-editable)

```sql
create type user_role as enum
  ('sales_exec','sales_manager','doctor','ops','coo','ceo','admin');

create type payment_state as enum ('unpaid','paid','partial','refunded','failed');

create type order_stage as enum
  ('pending_confirm','confirmed','dispatched','delivered','rto','cancelled');

create type consultation_state as enum ('pending','done','cancelled');

create type followup_kind as enum ('lead','consultation','order','rrr');

create type rrr_touch as enum ('response','mid','repeat_pitch','last_chance');

create type segment_code as enum ('A1','A2','B1','B2','C1','C2');

create type channel as enum ('elementor','wati','call','walkin','referral','zoho_legacy','other');
```

`order_stage` is an enum, not a lookup, because each value drives a distinct code path
(dispatch creates the RRR clock; rto reverses incentive). Adding a stage is a code change by
definition, so it should require a migration.

---

## 1. Identity & org

### `users`
Mirrors `auth.users`; app-level profile and role live here.

| column | type | notes |
|---|---|---|
| id | uuid pk | = `auth.users.id`, FK on delete cascade |
| full_name | text not null | |
| phone | text | E.164 |
| role | user_role not null default 'sales_exec' | |
| manager_id | uuid to users.id | for team rollups |
| is_active | boolean not null default true | |
| daily_lead_cap | int | used by absence redistribution "split by load" |

### `attendance`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid not null to users | |
| work_date | date not null | |
| status | text not null | `present` / `absent` / `half` / `leave` |
| marked_by | uuid to users | manager |
| unique (user_id, work_date) | | |

### `absence_events` (Phase 2)
Records a redistribution so "on return, untouched leads revert" is possible.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| absent_user_id | uuid not null to users | |
| strategy | text not null | `assign_one` / `round_robin` / `by_load` / `pool` |
| started_at / ended_at | timestamptz | |
| created_by | uuid to users | |

### `assignments`
Every ownership change of any entity, append-only. This is how "untouched leads revert" works
and how incentive credit is proven.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| entity_type | text not null | `lead` / `customer` / `order` / `followup` |
| entity_id | uuid not null | |
| from_user_id | uuid to users | null on first assign |
| to_user_id | uuid not null to users | |
| reason | text not null | `manual` / `round_robin` / `absence` / `rrr_pool` / `import` |
| absence_event_id | uuid to absence_events | set when reason = 'absence' |
| touched | boolean not null default false | set true the moment the new owner acts on it |
| assigned_at | timestamptz not null default now() | |

---

## 2. Lookups

All share the shape: `id uuid pk`, `code text unique not null`, `label_en text not null`,
`label_hi text` (Hinglish UI label), `sort_order int not null default 100`,
`is_active boolean not null default true`.

- `lead_sources` — seed: `elementor`, `wati`, `meta_ad`, `google_ad`, `organic`, `referral`,
  `walkin`, `repeat`, `zoho_legacy`
- `lead_statuses` — seed: `new`, `contacted`, `interested`, `consultation_booked`,
  `converted`, `lost`, `junk`
- `concerns` — the health concern captured at lead/consult time
- `couriers` — seed: `delhivery`, `shiprocket`
- `payment_modes` — seed: `gpay`, `gpay_cod`, `cod`, `razorpay`, `bank_transfer`
- `lost_reasons` — mandatory when a lead becomes lost
- `cancel_reasons` — mandatory when a consultation is cancelled

> Rule from PROJECT.md: **lookups, not free text.** The July sheet had
> `Lead Source = "Follow up"` on ~87 rows because columns shifted. A FK makes that
> class of bug impossible to store.

---

## 3. Golden Customer

### `customers`
One human = one row across all channels.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| phone_e164 | text not null **unique** | `+919990434773`. The identity key. |
| phone_raw | text | as first received, for audit |
| alt_phone_e164 | text | indexed, not unique |
| full_name | text not null | |
| email | citext | |
| gender | text | |
| age | int | |
| city / state | text | |
| address | text | **never auto-filled** |
| pincode | text | **never auto-filled**, CHECK six digits, not starting 0 |
| primary_concern_id | uuid to concerns | |
| first_source_id | uuid to lead_sources | attribution never overwritten |
| original_owner_id | uuid to users | incentive credit follows this, forever |
| current_owner_id | uuid to users | |
| lifetime_orders | int not null default 0 | trigger-maintained; avoids a count() per row in list views (egress) |
| lifetime_value | numeric(12,2) not null default 0 | trigger-maintained |
| last_order_at | timestamptz | |
| course_ends_at | date | last order dispatch + course_days; drives segment |
| segment | segment_code | nightly cron |
| is_dnd | boolean not null default false | |
| merged_into_id | uuid to customers | set on the loser of a duplicate merge |

`merged_into_id` is how "Zaid" and "Zaid WATI" collapse: the loser row is kept (so legacy
Zoho IDs still resolve) but every read filters `merged_into_id is null`.

### `customer_identities`
Every external key that ever pointed at this human. Makes the import idempotent and re-runnable.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| customer_id | uuid not null to customers | |
| system | text not null | `zoho` / `wati` / `elementor` / `razorpay` / `sheet` |
| external_id | text not null | |
| unique (system, external_id) | | |

---

## 4. Funnel

Sequence is fixed: Lead → Consultation (₹99) → Prescription → Order → Follow-up → Repeat.

### `leads`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| customer_id | uuid not null to customers | created/matched on ingest |
| source_id | uuid not null to lead_sources | |
| channel | channel not null | |
| status_id | uuid not null to lead_statuses | |
| concern_id | uuid to concerns | |
| payment_state | payment_state not null default 'unpaid' | the ₹99 consult fee |
| paid_at | timestamptz | set **only** by the Razorpay webhook |
| razorpay_payment_id | text unique | |
| amount | numeric(12,2) | **never auto-filled** beyond the webhook value |
| is_junk | boolean not null default false | |
| lost_reason_id | uuid to lost_reasons | required when status = lost |
| owner_id | uuid to users | |
| sla_due_at | timestamptz | first-response deadline; drives Aaj Ka Kaam rank 1 |
| first_contacted_at | timestamptz | |
| utm_source / utm_medium / utm_campaign | text | |
| raw_payload | jsonb | Elementor/WATI body as received. **Never selected in list views.** |

> `payment_state` on a lead is set by webhook only. There is no manual "paid" checkbox
> anywhere in the UI — PROJECT.md, Elementor Leads module.

### `consultations`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| customer_id | uuid not null to customers | |
| lead_id | uuid to leads | |
| doctor_id | uuid to users | role = doctor |
| scheduled_at | timestamptz | |
| state | consultation_state not null default 'pending' | |
| completed_at | timestamptz | |
| cancel_reason_id | uuid to cancel_reasons | **mandatory when state = cancelled** (CHECK) |
| fee_amount | numeric(12,2) | |
| fee_state | payment_state not null default 'unpaid' | |
| notes | text | doctor free text; never in a list projection |

```sql
constraint consult_cancel_reason_required
  check (state <> 'cancelled' or cancel_reason_id is not null)
```

### `prescriptions` (Phase 4 UI, schema now)
`id` · `consultation_id` · `customer_id` · `doctor_id` ·
`course_duration_days int not null` (**never auto-filled**) · `advice text` ·
`pdf_r2_key text` · `issued_at timestamptz`.

### `prescription_items`
`id` · `prescription_id` · `product_id` · `quantity int not null` · `dosage text`.

Rows, not columns — adding a SKU must never need a migration.

---

## 5. Catalogue & orders

### `products`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| sku | text unique not null | |
| name | text not null | Gold Plus, Daily Charge, Power Drive, Boost Up Oil, Shilajit Gold Resin |
| variant | text | `60N` / `30N` |
| is_combo | boolean not null default false | Confidence / Starter / 7-Day Booster |
| mrp / sale_price | numeric(12,2) | |
| default_course_days | int | a *default*, not an auto-fill of the order |
| is_active | boolean not null default true | |

### `combo_items`
`combo_product_id` to products · `component_product_id` to products · `quantity int`.
A combo's contents are data, not a hardcoded map.

### `orders`
| column | type | notes |
|---|---|---|
| id | uuid pk | |
| order_no | text unique not null | human-facing, sequence-generated |
| customer_id | uuid not null to customers | |
| consultation_id | uuid to consultations | |
| prescription_id | uuid to prescriptions | |
| stage | order_stage not null default 'pending_confirm' | |
| payment_state | payment_state not null default 'unpaid' | |
| payment_mode_id | uuid to payment_modes | |
| razorpay_payment_id | text unique | |
| amount | numeric(12,2) not null | **never auto-filled** |
| discount | numeric(12,2) not null default 0 | **never auto-filled** |
| shipping_amount | numeric(12,2) not null default 0 | |
| cod_amount | numeric(12,2) | |
| course_duration_days | int not null | **never auto-filled** — the RRR clock depends on it |
| ship_name / ship_address / ship_pincode / ship_city / ship_state | text | **never auto-filled** |
| courier_id | uuid to couriers | |
| awb | text | |
| dispatch_date | date | **setting this fires the RRR clock trigger** |
| delivered_at / rto_at | timestamptz | |
| is_repeat | boolean not null default false | true when customer.lifetime_orders > 0 at insert |
| original_owner_id | uuid not null to users | incentive credit |
| current_owner_id | uuid not null to users | |
| next_followup_at | date | generated column, see below |

```sql
next_followup_at date generated always as
  (dispatch_date + course_duration_days - 4) stored
```

Generated + stored means it can never drift and can never be AI-written. This enforces the
PROJECT.md rule structurally rather than by convention.

### `order_items`
`id` · `order_id` to orders (on delete cascade) · `product_id` to products ·
`quantity int not null check (quantity > 0)` · `unit_price numeric(12,2) not null` ·
`line_total numeric(12,2) generated always as (quantity * unit_price) stored`.

Rows, not a column per SKU. **This is a prescription — never auto-filled.**

---

## 6. Follow-ups & the RRR clock

### `followups`
Rows, not `Follow-up 1..5` columns. Unbounded by construction.

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| customer_id | uuid not null to customers | |
| kind | followup_kind not null | |
| lead_id / consultation_id / order_id | uuid | exactly one set (CHECK) |
| rrr_touch | rrr_touch | set when kind = 'rrr' |
| due_at | timestamptz not null | |
| owner_id | uuid not null to users | |
| outcome | text | `connected` / `no_answer` / `busy` / `wrong_number` / `not_interested` / `will_buy` |
| remark | text | |
| next_due_at | timestamptz | the rep's own next date |
| completed_at | timestamptz | |
| attempt_no | int not null default 1 | see pool rule below |

### `course_plans`
The RRR table as **data**, so a new course length is a row, not a code change.

| course_days | touches (offset days from dispatch) |
|---|---|
| 7 | response 2 · repeat_pitch 5 · last_chance 9 (no mid) |
| **15** | response 3 · mid 8 · **repeat_pitch 11** · last_chance 17 |
| 30 | response 5 · mid 15 · repeat_pitch 24 · last_chance 33 |
| 60 | response 7 · mid 30 · repeat_pitch 50 · last_chance 65 |
| 90 | response 10 · mid 45 · repeat_pitch 78 · last_chance 96 |

```sql
create table course_plans (
  id uuid primary key default gen_random_uuid(),
  course_days int not null,
  touch rrr_touch not null,
  offset_days int not null,
  unique (course_days, touch)
);
```

On `orders.dispatch_date` transitioning null to not-null, trigger `fn_create_rrr_followups()`
inserts one `followups` row per matching `course_plans` entry, at
`dispatch_date + offset_days`, owned by `orders.original_owner_id`.

> 87% of orders are 15-day courses. The 15d path is the hot path — index accordingly.

### Segments (nightly cron on `customers.course_ends_at`)
A1 0–15 · A2 16–30 · B1 31–60 · B2 61–90 · C1 91–180 · C2 180+ days past course end.
Written to `customers.segment` by a scheduled function, not computed per query — a per-query
`case` over 50k rows in a list view is exactly the kind of egress the constraints forbid.

### Ownership on RRR
RRR follow-ups go to `original_owner_id`. After **2 failed connect attempts**
(`attempt_no >= 3` with no `outcome = 'connected'`), the followup and the customer move to the
pool: `current_owner_id = null`, plus an `assignments` row with `reason = 'rrr_pool'`.
Incentive credit stays with `original_owner_id` regardless.

---

## 7. Messaging, spend, audit

### `wa_conversations` (Phase 2)
`id` · `customer_id` · `wa_id text` · `direction text` (`in`/`out`) · `template_name text` ·
`body text` · `status text` · `sent_at timestamptz` · `wati_message_id text unique`.

Never joined into a list view. Loaded only on row expand.

### `ad_spend` (Phase 4)
`id` · `spend_date date` · `platform text` · `campaign text` · `amount numeric(12,2)` ·
`leads int` · `unique (spend_date, platform, campaign)`. For CAC.

### `audit_log`
**Only these fields are logged:** `amount`, `status`, `owner_id`, `address`,
`payment_status`, `order_items`.

`id bigint identity pk` · `table_name text` · `record_id uuid` · `field text` ·
`old_value text` · `new_value text` · `changed_by uuid` · `changed_at timestamptz`.

```sql
constraint audit_field_allowlist check (field in
  ('amount','status','owner_id','address','payment_status','order_items'))
```

The allowlist is a CHECK constraint, not a trigger convention — a future careless trigger that
tries to log everything fails loudly instead of quietly burning quota.

### `webhook_events`
Raw inbound from Razorpay / Elementor / WATI. `provider text` · `event_id text unique` ·
`payload jsonb` · `received_at` · `processed_at` · `error text`.
`event_id` unique = idempotency. A retried Razorpay webhook must never double-mark paid.

---

## 8. Indexes (egress-shaped, not generic)

```sql
-- Aaj Ka Kaam: one queue, ORDER BY sla, paid, rrr, followup, unpaid
create index on leads (owner_id, payment_state, sla_due_at);
create index on followups (owner_id, due_at) where completed_at is null;
create index on orders (current_owner_id, stage, next_followup_at);

-- module tabs
create index on leads (payment_state, created_at desc) where is_junk = false;
create index on consultations (state, scheduled_at desc);
create index on orders (stage, created_at desc);

-- identity
create unique index on customers (phone_e164) where merged_into_id is null;
create index on customers (segment, course_ends_at);

-- children
create index on order_items (order_id);
create index on followups (customer_id, due_at desc);
create index on audit_log (record_id, changed_at desc);
```

Every list view must be satisfiable by an index-ordered range scan with an explicit column
list and `.range(from, to)`. `select *` is never written; `raw_payload`, `notes`, `body` and
`payload` columns never appear in a list projection.

---

## 9. Views for list screens (column discipline enforced in SQL)

Rather than trusting each component to name columns, each module gets a narrow view:

- `v_leads_list` — id, customer name, masked phone, source label, status label, payment_state, sla_due_at, owner
- `v_consultations_list` — id, customer name, doctor, scheduled_at, state, fee_state
- `v_orders_list` — id, order_no, customer name, amount, stage, payment_state, courier, awb, dispatch_date, next_followup_at
- `v_aaj_ka_kaam` — the unioned priority queue with a `rank_bucket int` column

A view cannot be `select *`-ed into a wide payload by accident. The full record is a separate
single-row fetch on expand.

---

## 10. RLS sketch (policies + tests in a separate migration)

- Every table: `enable row level security` **and** `force row level security`.
- `sales_exec` — `using (current_owner_id = auth.uid() or owner_id = auth.uid())`; for
  `customers`, only those with a lead/order they own.
- Pool rows (`current_owner_id is null`) readable by any `sales_exec` with the **phone masked**.
  Masking is column-level, so the pool is exposed through `v_pool_leads` selecting
  `mask_phone(phone_e164)` while the base table stays unreadable.
- `sales_manager` — own team via `users.manager_id`.
- `doctor` — consultations/prescriptions assigned to them, plus those customers.
- `ops` — orders in confirmed/dispatched/delivered/rto; no lead access.
- `coo` / `ceo` — read all, write none (except `ad_spend`).
- `admin` — all.
- Bulk CSV export goes through an Edge Function gated on
  `role in ('sales_manager','coo','ceo','admin')`.

Tests must prove a `sales_exec` JWT cannot read another exec's rows **via a crafted PostgREST
call**, not merely that the UI hides them.

---

## Open questions blocking migration 001

Listed in `docs/open-questions.md`. Several affect column types, so the diff should not be
approved until they are answered.
