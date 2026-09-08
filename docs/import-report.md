# import-report.md — July sheets, 2026-09-07

Source: the two authoritative tabs. Command: `node scripts/import-sheets.mjs --commit`
(re-runnable; dry run by default).

## Loaded

| | count |
|---|---|
| customers (Golden) | **501** |
| consultations | **534** — 444 done · 82 pending · 8 cancelled |
| orders | **168** — 127 delivered · 35 confirmed · 6 pending confirm |
| order_items | 392 |
| followups | 539 |

## Rejected — 23 rows, all in `import_rejects`

| reason | n | what to do |
|---|---|---|
| `followup_without_date` | 18 | follow-up cell has no leading date; text preserved in the reject payload |
| `unknown_status` | 2 | Consultation Status blank |
| `no_product_lines` | 3 | order with no quantity in any SKU column (user: reject) |

A clean import with honest rejects is the goal. Zero rejects would mean the importer guessed.

## Reconciliation against PROJECT.md's July figures

| metric | PROJECT.md | imported | note |
|---|---|---|---|
| repeat orders | **70** | **70** | exact |
| consultations | 507 | 534 | file has 536 rows |
| — done | 415 | 444 | |
| — pending | 84 | 82 | |
| — cancelled | 8 | 8 | exact |
| orders | 163 | 168 | 171 rows − 3 rejected |
| 15-day courses | 142 | 149 | |

The reference numbers were a snapshot; the export is later and has more rows. The two figures
that cannot drift — repeat orders and cancellations — match exactly, so the mapping is sound.

## Integrity checks (all pass)

- duplicate live phone numbers: **0**
- orders with a null amount: **0**
- legacy `order_items` given an invented `unit_price`: **0** (D-009)
- orders with a dispatch date: **0** (D-023 — correct, the source has none)
- 707 source rows collapsed to **501 golden customers**; 25 have more than one order

## What this shows about the core problem

444 completed consultations produced 168 orders. **361 of 501 customers have never ordered.**
That is the ~322 figure PROJECT.md describes, now queryable instead of buried in a spreadsheet.

## Ownership (incentive follows `original_owner_id`, frozen)

| | orders | value |
|---|---|---|
| Shreyansh | 71 | ₹1,91,045 |
| Tejasv | 64 | ₹1,82,615 |
| Ashutosh | 33 | ₹69,816 |

## Products sold in July

Power Drive 269 · Boost Up Oil 96 · Daily Charge 30N 94 · Gold Plus 30N 33 ·
Daily Charge 60N 17 · Gold Plus 60N 9 · Shilajit 5

## Known gaps, by decision not by accident

- No `dispatch_date`, so no RRR follow-ups for historical orders (D-023). The old cohort is
  worked through `customers.segment`.
- `order_items.unit_price` is NULL on every legacy row (D-009).
- Follow-up `outcome` is NULL; the full text is in `remark` (D-034).
- No `leads` rows were created from these tabs — the sheet records consultations, not leads.
  Leads come from the Zoho import and, going forward, the Elementor webhook.

---

# Zoho Consultation Leads — full history, 2026-09-08

`node scripts/import-zoho.mjs` · all 52,177 rows, batched at 5,000 with `VACUUM ANALYZE`
between. Idempotent: `customer_identities(system='zoho')` records every Record Id loaded, so a
re-run resumes rather than duplicating.

## Loaded

| | |
|---|---|
| customers | **51,316** (was 501) |
| leads | **51,927** |
| follow-ups | **21,272** (was 539) |
| customer_identities | 51,927 |
| rejects | 250 — unparseable phone |
| **database size** | **65 MB of the free tier's 500 MB** |

## The Golden Customer merge worked

- 52,177 source rows → **51,316 customers**
- **607 customers hold more than one Zoho record** — the "Zaid / Zaid WATI" pattern, matching
  the 607 duplicated phones found during profiling
- duplicate live phones: **0** · orphan leads: **0** · orphan follow-ups: **0**
- 12 customers legitimately named Swati / Bhagawati / Parwati / Inwati were left intact (D-044)

## Ownership

| owner | active | leads |
|---|---|---|
| *(pool — unassigned)* | | **38,334** |
| Anshu Chauhan | no | 5,982 |
| Tripti Chauhan | no | 2,504 |
| Harshal Deep | no | 1,013 |
| Ashutosh | **yes** | 869 |
| Tejasv | **yes** | 762 |
| Nisha | no | 723 |
| Shreyansh | **yes** | 688 |
| Saloni Srivastava | no | 660 |
| Varun Kumar | no | 198 |
| Ashutosh Saxena | no | 172 |

38,334 unowned leads are the pool. A `sales_exec` cannot read them from `leads` at all; they
appear only through `v_pool_leads` with the phone masked — verified live: `78••••5156`.

## Status and concern spread

Contacted 29,480 · New 15,059 · Converted 7,388
Sexologist 27,785 · Ayurveda 7,963 · Gynecologist 2,798 · Menstrual Problem 713 ·
Sexual Problem 306 · Skin Problem 210

## After the import

- RLS suite: **27/27**
- backup: 178,029 rows, **9.36 MB gzipped**, uploaded and verified by re-download
