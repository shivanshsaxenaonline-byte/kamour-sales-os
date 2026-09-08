# mapping-legacy-to-target.md

How the three legacy sources land in the target schema.

Sources, in order of authority
1. **Zoho CRM** — 52,072 rows (all modules). Import **last 12 months only**, ~15k rows.
   Older rows archived to R2 as CSV, never loaded into Postgres.
2. **Google Sheets** — 9 tabs, but only **two are authoritative** for the new sales team
   (confirmed 2026-09-07):
   - **`Consultation Record`** -> `consultations` (+ `customers` via merge)
   - **`Medicine Order Record`** -> `orders` + `order_items` + `followups` (+ `customers`)

   The other 7 tabs are treated as **archive**: exported to R2 as CSV, not loaded into Postgres.
   They are still worth one read-only pass before archiving, to confirm no table's only source
   lives in them (specifically: dispatch/courier data and the ₹99 payment flag — if either is
   kept in a separate tab rather than in these two, that tab is promoted to authoritative).
3. **WATI** — contact list, for phone-level merge into the Golden Customer.

Legend
- ✅ mapping is determined by PROJECT.md and needs no decision
- ⚠️ **CONFIRM** — needs a human answer before the import runs; see `open-questions.md`
- ⛔ dropped on purpose, with the reason

> Column names below are the ones Zoho and the sheet *usually* use. The exact headers must be
> read off the real export before migration 005 is written; the target side and the transform
> rules are what this document fixes. Rename on the left, never on the right.

---

## 1. Transform rules that apply to every source

### 1.1 Phone normalisation (the identity key)

```
raw -> strip everything except digits and a leading +
    -> drop leading 0 / 91 / +91 / 0091 prefixes
    -> keep last 10 digits, must match ^[6-9][0-9]{9}$
    -> emit '+91' || those 10 digits
```

- Result goes to `customers.phone_e164`; the untouched original goes to `phone_raw`.
- Anything that fails the 10-digit check is **not** imported as a customer. It lands in
  `import_rejects` with the reason, for a human to fix. Never guess a phone number.
- A second number in the same cell (`98xxxx / 99xxxx`) → first to `phone_e164`,
  second to `alt_phone_e164`.

### 1.2 Golden Customer merge

Match order, first hit wins:
1. `customers.phone_e164` exact
2. `customer_identities (system, external_id)` exact
3. `alt_phone_e164` exact

On a hit, the existing row is kept and enriched **only where the target field is null**. An
existing non-null `address`, `pincode`, `amount` or `full_name` is never overwritten by an
import. Every source row contributes a `customer_identities` row regardless, so the import is
idempotent and re-runnable.

This is what collapses "Zaid" and "Zaid WATI" into one row. **Merging happens during import,
not after** — a post-hoc dedupe pass would have to rewrite FKs across every child table.

Attribution on merge:
- `first_source_id` / `original_owner_id` — taken from the **earliest** `created_at` among
  the merged rows, then frozen forever.
- `current_owner_id` — taken from the **latest** row.

### 1.3 Lookups

Every legacy free-text value is passed through a per-lookup alias map
(`supabase/seed/lookup_aliases.csv`), e.g. `Delhivery` / `delhivery` / `DELHIVERY ` →
`couriers.code = 'delhivery'`. An unmapped value does **not** create a lookup row silently —
it goes to `import_rejects` and the alias map is extended by a human.

Known booby trap — **and it is not what PROJECT.md thought** (see decisions.md D-021): the
July sheet has `Lead Source = "Follow up"` on 86 rows, `Payment = "Follow up"` on 91 and
`Amount = "Follow up"` on 90. These are **not** shifted columns — every row has exactly 34
fields. They co-occur with `Conversion Type = 'Follow up'` and mean "no fresh payment, no fresh
source, this came off a follow-up". Import them as **NULL**, keep the fact in
`conversion_type`. Do not reject.

### 1.4 Dates
Legacy dates are Indian-format strings (`dd/mm/yyyy`, `dd-mm-yy`, sometimes Excel serials).
Parse with an explicit format list, in that order, in IST, then store UTC. **Ambiguous dates
(`03/04/2026`) are parsed dd/mm and flagged** — never silently assumed.

### 1.5 Money
Strip `₹`, commas, spaces. Reject anything that is not a clean number — do not round, do not
default to 0. Money is on the never-auto-fill list.

---

## 2. Zoho `Leads` and `Contacts` → `customers` + `leads`

| Zoho field | Target | Notes |
|---|---|---|
| `Record Id` | `customer_identities(system='zoho', external_id)` | ✅ keeps legacy links resolvable |
| `Phone` / `Mobile` | `customers.phone_e164` + `phone_raw` | ✅ §1.1 |
| `Full Name` / `First Name` + `Last Name` | `customers.full_name` | ✅ trim, collapse spaces, strip channel suffixes like `WATI` |
| `Email` | `customers.email` | ✅ lowercase; invalid → null, not rejected |
| `Mailing Street` / `Street` | `customers.address` | ✅ verbatim, never cleaned |
| `Zip Code` | `customers.pincode` | ✅ verbatim; fails 6-digit CHECK → reject row, do not repair |
| `City` / `State` | `customers.city` / `state` | ✅ |
| `Lead Source` | `leads.source_id` | ⚠️ alias map required |
| `Lead Status` | `leads.status_id` | ⚠️ alias map required |
| `Owner` | `leads.owner_id`, `customers.original_owner_id` | ⚠️ **CONFIRM** the Zoho-user to `users` map |
| `Created Time` | `leads.created_at` | ✅ IST → UTC |
| `Description` / notes | `leads.raw_payload.legacy_note` | ✅ kept out of list projections |
| `Concern` / custom field | `leads.concern_id` | ⚠️ field name unknown |
| Lead scoring / Zoho workflow fields | ⛔ | Zoho-internal, no meaning here |
| `Layout`, `Tag`, `Approval State` | ⛔ | Zoho-internal |

Every imported Zoho lead gets `channel = 'zoho_legacy'` and
`source_id = lead_sources.code = 'zoho_legacy'` **only when the original source is unmappable** —
otherwise the real source is preserved. Attribution matters more than tidiness.

---

## 3. Sheet tab `Consultation Record` → `consultations`

Reference numbers to reconcile against (July 2026): **507 consultations = 415 done + 84 pending
+ 8 cancelled.** If the import produces different totals, the import is wrong, not the sheet.

| Sheet column | Target | Notes |
|---|---|---|
| Date | `scheduled_at` | ✅ §1.4 |
| Customer name / phone | resolved to `customer_id` | ✅ §1.2 |
| Status (Done / Pending / Cancelled) | `state` | ✅ direct 3-value map |
| Cancel reason | `cancel_reason_id` | ⚠️ cancelled rows with a blank reason **fail the CHECK constraint**. 8 rows — resolve by hand, do not invent a reason. |
| Doctor | `doctor_id` | ⚠️ **CONFIRM** doctor name to `users` map |
| ₹99 paid? | `fee_state` | ⚠️ **CONFIRM** how the sheet records this |
| Remarks | `notes` | ✅ |

---

## 4. Sheet tab `Medicine Order Record` → `orders` + `order_items`

Reference: **163 orders · 70 repeat (43%) · 93 new · 142 of 163 are 15-day courses (87%)**.
Payment split: Gpay+COD 76, Gpay 62, Razorpay 10. Courier: Delhivery 119, Shiprocket 33.
(76 + 62 + 10 = 148, not 163 — see `open-questions.md` Q7.)

### 4.1 Header fields

| Sheet column | Target | Notes |
|---|---|---|
| Order date | `orders.created_at` | ✅ |
| Customer name / phone | `customer_id` | ✅ §1.2 |
| Amount / Total | `amount` | ✅ §1.5, never repaired |
| Discount | `discount` | ✅ blank → 0 is acceptable here **only** because 0 is the true default |
| Payment mode | `payment_mode_id` | ✅ `Gpay+COD` → `gpay_cod` |
| Paid / Unpaid | `payment_state` | ✅ |
| Razorpay id | `razorpay_payment_id` | ✅ |
| Course duration | `course_duration_days` | ⚠️ **blank is fatal** — the RRR clock cannot be derived. Reject; do not default to 15 even though 87% are 15. |
| Address | `ship_address` | ✅ verbatim |
| Pincode | `ship_pincode` | ✅ verbatim, CHECK enforced |
| Courier | `courier_id` | ✅ alias map |
| AWB / tracking | `awb` | ✅ |
| Dispatch date | `dispatch_date` | ✅ **see §4.3** |
| Delivered / RTO | `stage` + `delivered_at` / `rto_at` | ✅ |
| Sales person | `original_owner_id` **and** `current_owner_id` | ⚠️ **CONFIRM** name map |
| Follow-up 1..5 | ⛔ **not** columns on `orders` | → §6 |
| One column per SKU | ⛔ **not** columns on `orders` | → §4.2 |
| `Next follow-up` (if present) | ⛔ **dropped** | it is a generated column now: `dispatch_date + course_duration_days - 4`. Importing a stale sheet value would defeat the formula. |

### 4.2 SKU columns → `order_items` rows (unpivot)

The sheet has a column per product. The import walks those columns per row and emits one
`order_items` row wherever the cell is non-empty:

```
for each sku_column in [Gold Plus 60N, Gold Plus 30N, Daily Charge 60N, Daily Charge 30N,
                        Power Drive, Boost Up Oil, Shilajit Gold Resin,
                        Confidence Combo, Starter Combo, 7-Day Booster Combo]:
    qty = cell value
    if qty is blank or 0: skip
    emit order_items(order_id, product_id = products.sku_for(sku_column), quantity = qty,
                     unit_price = ⚠️ CONFIRM)
```

⚠️ **CONFIRM (Q3):** the sheet records an order total, not per-line prices. Three options —
back-fill `unit_price` from the current `products.sale_price`, store `unit_price = null` for
legacy rows, or distribute the total pro-rata. Pro-rata is a fabricated number on a
prescription record, so it is not recommended. **This blocks the orders import.**

Products are seeded first, from `products`, never hardcoded in the importer. Adding a SKU is a
row in `products` plus a line in the column map.

### 4.3 Dispatch date and the RRR clock — import order matters

The `dispatch_date` trigger creates RRR follow-ups. During import that would generate tens of
thousands of historical follow-ups, most of them long past due, and flood every rep's
Aaj Ka Kaam on day one.

Import procedure:
1. `alter table orders disable trigger fn_create_rrr_followups;`
2. Load all historical orders with their real `dispatch_date`.
3. Re-enable the trigger.
4. Backfill RRR follow-ups **only for orders whose course has not yet ended**
   (`dispatch_date + course_duration_days >= current_date`), and only for touches still in the
   future. Past-due historical touches are not created.
5. Everything older is represented by `customers.segment` (A1…C2), which is what the RRR
   module is actually for.

⚠️ **CONFIRM (Q5):** should closed/delivered orders from months ago produce *any* live
follow-up? Default assumed above: no — they surface through segments instead.

---

## 5. The shifted-column rows (~87)

Detection, run **before** import, not during:

```sql
-- any row whose Lead Source value is not in the alias map
-- AND whose neighbouring columns also fail their own type checks
-- is a shifted row, not a data-entry typo
```

Shifted rows are quarantined to `import_rejects` with `reason = 'column_shift'` and a CSV is
handed back for manual repair. They are **not** imported with a guessed source — the whole
point of the lookup tables is that this class of bug stops being storable.

---

## 6. Follow-up 1..5 columns → `followups` rows (unpivot)

```
for n in 1..5:
    if Follow-up n is blank: continue
    emit followups(customer_id, kind, order_id/lead_id,
                   due_at   = parsed date from the cell,
                   remark   = the cell's text,
                   outcome  = ⚠️ CONFIRM — the sheet mixes date and outcome in one cell,
                   owner_id = the row's sales person,
                   attempt_no = n,
                   completed_at = the parsed date, since a written follow-up is a done one)
```

⚠️ **CONFIRM (Q4):** the cells appear to hold free text like `12/7 no answer`. Confirm the
convention, or accept that legacy `outcome` stays null and only `remark` is populated. Null
outcome is the honest option and is recommended.

The sheet ran out at 5. The target has no such limit — that is the entire reason for the table.

---

## 7. WATI → `wa_conversations` + merge

WATI's contribution to Phase 1 is **the merge only**. Message history is Phase 2.

| WATI field | Target |
|---|---|
| `waId` | `customer_identities(system='wati')` + phone normalisation |
| contact name | used for merge matching, **not** to overwrite `full_name` |
| message rows | `wa_conversations` — ⚠️ **CONFIRM (Q6)** whether to import history at all. It is the single largest row count outside Zoho and it earns nothing in Phase 1. Recommendation: archive to R2, import nothing. |

---

## 8. Batching (Supabase read-only-mode hazard)

Supabase forces read-only if a single load exceeds ~1.5× current DB size.

```
order of load, each a separate batch:
  1. lookups + products + course_plans   (seed, tiny)
  2. users                               (~15 rows, manual)
  3. customers                           batches of 5,000, VACUUM ANALYZE between
  4. customer_identities                 batches of 5,000
  5. leads                               batches of 5,000
  6. consultations                       batches of 5,000
  7. orders          (triggers disabled) batches of 5,000
  8. order_items                         batches of 5,000
  9. followups                           batches of 5,000
 10. re-enable triggers, backfill live RRR (§4.3), refresh segments
```

After each batch: `VACUUM ANALYZE <table>;` and record `pg_database_size()` in
`docs/egress-log.md`. Stop immediately if size growth in one batch approaches the current
total — that is the read-only trigger.

`import_rejects (source, source_row_no, reason, payload jsonb)` is written to throughout and
is the deliverable at the end. A clean import with 400 honest rejects is a success. An import
with zero rejects means the importer guessed somewhere.

---

## 9. Post-import verification (must pass before Phase 1 UI work starts)

| Check | Expected |
|---|---|
| `select count(*) from consultations where created_at in July` | 507 |
| state split | 415 done / 84 pending / 8 cancelled |
| `select count(*) from orders` for July | 163 |
| `count(*) where is_repeat` | 70 (43%) |
| `count(*) where course_duration_days = 15` | 142 (87%) |
| lead source share, Elementor | ~75% |
| courier split | Delhivery 119 / Shiprocket 33 |
| `select count(*) from customers where merged_into_id is null` | < raw row count — merges happened |
| duplicate phones | 0 |
| orders with null `course_duration_days` | 0 (rejected instead) |
| `next_followup_at` | never null where `dispatch_date` is set |

Any mismatch is investigated, not explained away.
