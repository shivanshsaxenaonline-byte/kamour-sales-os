# open-questions.md

Per AGENT RULES #2: ask instead of guessing. Each question below blocks something specific.
Nothing marked **BLOCKER** proceeds until answered.

## Access

**Q0 — RESOLVED 2026-09-07.** Credentials supplied; project `gcmexzynmygvwymnfutw` inspected.
See `docs/schema-current.md`.

**Q0b — BLOCKER, Phase 0 step 2.** The project is **completely empty** — 0 tables, 0 auth users,
0 storage objects, no migrations. PROJECT.md states a staging DB with partial data already exists.
Which is true?
(a) The staging data is in a **different project or org** — send that one and the inventory re-runs.
(b) There is no staging data and the PROJECT.md line is stale — this is a clean slate, and
`schema-diff.md` becomes simply the whole of `schema-target.md`.
Nothing is created until this is answered. AGENT RULES #1.

## Import

**Q1 — PARTLY ANSWERED by the export.** The sheet names exactly three sales people, matching
"3 sales execs": **Shreyansh**, **Tejasv**, **Ashutosh** (they appear as `Joined By`,
`Conversion By` and `Consultation Taken By`). `Nakul Sharma` appears only as `Saved in CRM by`
×413 — a back-office/CRM role, not a sales owner.
Still needed: (a) each person's email, for their auth account; (b) who the **manager** is;
(c) confirmation that `Conversion By` — not `Joined By` — is the owner who earns the credit on
an order. These two columns disagree on many rows, and `original_owner_id` freezes at import.

**Q2 — BLOCKER, import.** Doctor name → `users` map for the consultations tab.

**Q3 — BLOCKER, orders import.** Legacy `order_items.unit_price`. The sheet stores an order
total, not per-line prices. Options: (a) back-fill from current `products.sale_price`,
(b) leave null on legacy rows, (c) pro-rata split of the total.
Recommendation: **(b)**. (c) fabricates a number on a prescription record.

**Q4 — orders import.** The `Follow-up 1..5` cells look like free text (`12/7 no answer`).
Is there a convention, or should legacy `outcome` stay null with only `remark` populated?
Recommendation: **null outcome**.

**Q5 — orders import.** Should historical orders whose course already ended produce any live
RRR follow-up? Recommendation: **no** — they surface via `customers.segment` instead.
Otherwise every rep opens Aaj Ka Kaam on day one to thousands of overdue rows.

**Q6a — RESOLVED 2026-09-07.** Of the 9 sheet tabs, only `Consultation Record` and
`Medicine Order Record` carry the new sales team's data. The other 7 are archived to R2, not
imported. Still to confirm: that dispatch/courier fields and the ₹99 paid flag live *inside*
those two tabs and not in a separate one (Q21).

**Q21 — ANSWERED by the export.** `Medicine Order Record` HAS courier (`Shipped By`) and
`Delivered Date`, but NO dispatch date and NO AWB. See Q22.

**Q22 — RESOLVED 2026-09-07 (D-023): skip RRR for old orders.** Original text: There is no dispatch date in the source. `orders.dispatch_date`
starts the RRR clock and generates `next_followup_at`. Options:
(a) another tab or a courier panel holds the real dispatch dates — send it;
(b) use `Delivered Date` minus a fixed transit assumption — every RRR touch then lands wrong by
however far that assumption is off;
(c) use `Date of Order` — usually 0–1 days before dispatch, so closest of the three;
(d) import historical orders with a null dispatch date, create no RRR follow-ups, and rely
entirely on `customers.segment` for the old population.
Recommendation: **(a) if it exists, else (d)**. A repeat pitch sent on the wrong day is worse
than one not sent, and segments already cover this cohort.

**Q23 — RESOLVED 2026-09-07 (D-025): 9 is a real discretionary price.** Original text: (alongside `₹99` ×387 and `Free` ×7).
Is `9` a typo for ₹99, a genuine ₹9 offer, or something else? It is money, so I will not assume.

**Q24 — PARTLY RESOLVED (D-026): Rupendra = Rupender Singh, one person.** Still open: the `Sales Team` / `NO DOCTOR` / `Sales + Rupendra` values. Original text: Consultation Record says `Dr. Rupendra`;
Medicine Order Record says `Dr Rupender Singh`. Same person? Also, `Sales Team` (107 orders),
`NO DOCTOR` (52) and `Sales + Rupendra` (132) appear in the doctor column — these are
consultations with no doctor involved. Confirm `doctor_id` should be NULL for those, with the
fact recorded elsewhere.

**Q25 — RESOLVED: all confirmed real, seeded in migration 014.** Original text:, not in the seed. Confirm each is real and not a
typo before I add it:
- couriers: `Bluedart` ×7, `Shadow Fax` ×1, `DTDC` ×1, `Maruti` ×1, `Store` ×1
- payment modes: `Prepaid` ×4
- lead sources: `Reactivation`, `Calling`, `Wati Elementor`, `Justdial`, `Facebook`,
  `Instagram`, `Flipkart`, `India mart`, `Kapeefit`
(`Store` and `Maruti` look like local/hand delivery rather than couriers — confirm.)

**Q26 — RESOLVED: reject them.** Original text: in any SKU column.** Nothing to put in
`order_items`. Reject them, or are they real orders recorded elsewhere?

**Q6 — PARTLY RESOLVED: Zoho fully imported; WATI history still not imported.** Original text: Import WATI message history into `wa_conversations`, or archive to R2?
It is the largest row count outside Zoho and earns nothing in Phase 1.
Recommendation: **archive, import nothing**; the merge uses `waId` only.

**Q7 — data reconciliation.** July payment split is Gpay+COD 76 + Gpay 62 + Razorpay 10 = 148,
but there are 163 orders. What are the other 15 — blank payment mode, pure COD, or a mode not
listed? This decides whether `payment_mode_id` is nullable and whether `cod` is a seed value.

**Q8 — consultations.** How does the sheet record whether the ₹99 consult fee was paid? Maps to
`consultations.fee_state`.

**Q9 — cancelled consultations.** 8 July rows are cancelled. `cancel_reason_id` is a CHECK-enforced
requirement. If the sheet has no reason for them, they need reasons entered by hand or a seeded
`cancel_reasons.code = 'legacy_unknown'` used exactly once, for the import only.

## Business rules

**Q10 — RESOLVED (D-029): 15 minutes.** Original text: `leads.sla_due_at` is the top of the Aaj Ka Kaam ranking, but PROJECT.md never
states the SLA. What is the first-response deadline for a paid Elementor lead — 15 min? 1 hour?
Same working day? Does it differ for unpaid?

**Q11 — pool.** "Moves to pool only after 2 failed connect attempts." Confirm this means the
3rd attempt is made by the pool, i.e. two attempts with `outcome != 'connected'` are what
trigger the move. Also: is there a time bound (2 failures within N days)?

**Q12 — order numbers.** Format for `orders.order_no`. Does an existing sequence from the sheet
have to be continued, or does the new system start fresh?

**Q13 — repeat definition.** `is_repeat` = customer has any prior order, or a prior *delivered*
order? An RTO'd first order followed by a second — is the second a repeat? This changes the 43%
number.

**Q14 — RTO and incentive.** Does an RTO reverse the sales exec's incentive credit? Affects
whether `rto_at` needs to write a compensating row anywhere.

**Q15 — masked phone scope.** Masking is specified for unassigned leads. Does a `sales_exec`
see the full phone on their **own** rows (assumed yes), and does a `sales_manager` see full
phones across the team (assumed yes)?

**Q16 — 7-day course.** The RRR table has no `mid` touch for 7d. Confirm that is intentional
and not an omission.

**Q17 — RESOLVED 2026-09-07 (D-025): the fee is NOT fixed.** Original text: Is ₹99 fixed, or does it vary? Decides whether `fee_amount` has a
default or must always be entered.

**Q18 — RESOLVED (D-027/D-028): prices and course days loaded from the pricing board.** Original text: and per-SKU course lengths.** `products` is seeded with names, variants
and SKUs from PROJECT.md, but `mrp`, `sale_price` and `default_course_days` are NULL — money is
on the never-auto-fill list and was not mine to invent. Send the price list and these fill in
with one UPDATE. Blocks: the "Order banao" form showing a price.

**Q19 — RESOLVED: seeded from the Ad column, confirmed by the user.** Original text: Deliberately not seeded. This is clinical vocabulary and must
come from the doctors. Blocks: the concern dropdown on leads and consultations.

**Q20 — combo contents.** `combo_items` is empty. What does each of Confidence Combo, Starter
Combo and 7-Day Booster Combo actually contain, and in what quantities?


**Q27 — RESOLVED (D-031): accounts created, Ashutosh is the manager.** Original text: Needed to create the auth accounts.
For Shreyansh, Tejasv, Ashutosh: full name + email. Which one (or who else) is the
sales manager? And what is Nakul Sharma's role — admin?

**Q28 — RESOLVED (D-031): doctor records created, no logins needed.** Original text: Full name + email for each doctor to be given a login:
Dr. Rupendra (= Dr Rupender Singh), Dr. Harsh, Dr. Shubham (the sheet has both
"Dr. Shubham Home" and "Dr. Shubham Office" — same person at two locations?),
Dr. Dinesh, Dr. Rajeev.


**Q29 — Confidence / Starter Combo: contents found, prices CONFLICT.**
`kamour.in` returns 403 to automated requests (Cloudflare), so this came from
`kapeefit.com/product/kamour-confidence-combo/` plus search results. Treat as unverified.

Contents (both sources agree):
- **15-Day Starter**: Gold Plus 30 caps + Power Drive 7 caps + Boost Up Oil 30 ml
- **30-Day Full**:    Gold Plus 60 caps + Power Drive 14 caps + Boost Up Oil 30 ml

Prices — website vs the wall board:
| | website | wall board (CGA funnel) |
|---|---|---|
| Confidence / 30-day | ₹7,692 | ₹7,682 (13% off ~₹8,0xx) |
| Starter / 15-day    | ₹4,583 | ~₹3,25x (22% off ~₹4,1xx) |

The 30-day figures differ by ₹10 and are almost certainly the same product (or my reading of a
blurry photo). **The 15-day figures differ by ~₹1,300 and cannot both be right.** Note the wall
column is headed "Discount (Busy & Website)", so the board may be internal funnel pricing that
deliberately differs from the public site.

Two things to confirm before anything is loaded:
1. Is `Starter Combo` = the 15-Day Starter, and `Confidence Combo` = the 30-Day Full? PROJECT.md
   lists them as two separate products; the website presents them as two variants of one.
2. Which price does the sales team actually quote — the board or the website?

Nothing is blocked: neither combo appears as a column in the July order sheet. Loading a wrong
price onto a prescription record is worse than leaving it null (D-009, D-027).

**Q30 — RESOLVED 2026-09-07: `ops` confirmed correct for Nakul.** Original text: `ops` currently means
"sees confirmed/dispatched/delivered/RTO orders, no lead access". If data entry means typing in
leads and orders across the whole team, `ops` is too narrow and `admin` or a dedicated role fits
better. Say which and it is a one-line update.


## Zoho import (received 2026-09-07)

**Q31 — RESOLVED (D-038): Ashutosh Pal is ours; Tejas = Tejasv.** Original text:
`Follow-up N Done By` contains both **`Ashutosh Pal`** (2,122 rows; 1,453 in the last 12 months)
and **`Ashutosh Saxena`** (230; 1 recent). Which is our Ashutosh — or is neither?
Likewise **`Tejas`** (828) and **`Tejasv`** (536) look like one person spelled two ways.
Confirm, because this sets `original_owner_id` and incentive credit follows it permanently.

**Q32 — RESOLVED (D-039): create as inactive users, no login.** Original text:
These names do real work in the data but are not in the 8-person team list:
Anshu Chauhan 7,883 · Tripti Chauhan 3,360 · Harshal Deep 1,435 · Nisha 1,341 ·
Saloni Srivastava 817 · Varun Kumar 202 · Priyanka 20 · Prerna Agarwal 2.
Nisha (738) and Harshal Deep (433) are still active inside the 12-month window.
Options:
(a) create them as `users` with `is_active = false` and no login — history stays truthful,
    they appear in old follow-ups but in no dropdown. **Recommended.**
(b) import those follow-ups with `owner_id = null` — loses who did the work.
Are any of them still employed?

**Q33 — RESOLVED (D-041): import everything, no archive.** Original text: 11,728 rows in, 40,449 archived to R2. PROJECT.md says
12 months (~15k); the real figure is 11,728. Import all 52,177 instead? Not recommended — it is
4x the rows for leads that are 2–3 years cold, and egress is the binding constraint.

**Q34 — RESOLVED: Zoho Diseases loaded as concerns alongside the Ad-derived ones (21 total).** Original text: Zoho has 18 real values (Sexologist 27,926,
Ayurveda 7,999, Gynecologist 2,818 …), which is better evidence than the `Ad` column I seeded
from. Replace the seed with these, merging `Stomach Problem(s)` and `Male Problem(s)`?

**Q35 — RESOLVED: blank -> new, Need Followup -> contacted, Converted -> converted.** Original text: Only `Need Followup` (29,691) and `Converted` (7,405), with 29%
blank. Map blank -> `new`, `Need Followup` -> `contacted`, `Converted` -> `converted`?
