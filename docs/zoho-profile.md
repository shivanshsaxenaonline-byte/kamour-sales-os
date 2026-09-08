# zoho-profile.md — Consultation Leads export, 2026-09-07

`Consultation_Lead_2026_09_07.csv` · **52,177 rows × 58 columns** · not one ragged row.

## Quality: better than expected

| | |
|---|---|
| `Record Id` | 100% filled, **52,177 distinct** — a perfect key for `customer_identities` |
| `Contact Number` | **51,927 of 52,177 parse to E.164 (99.5%)** |
| distinct phones | 51,296 — so **607 phones appear on more than one row** |
| `Created Time` | 2023: 10,978 · 2024: 8,142 · 2025: 24,845 · 2026: 8,212 |

## The 12-month window (PROJECT.md: import 12 months, archive the rest)

Cut at 2025-09-07:

- **11,728 rows in window** → import
- **40,449 rows older** → archive to R2 as CSV, never loaded
- 11,505 distinct phones in window
- **459 of them are already `customers`** from the July sheet import
- **11,046 genuinely new customers** → 501 becomes ~11,547

## The Golden Customer duplicate pattern, confirmed live

PROJECT.md predicted "Zaid" and "Zaid WATI" as two rows for one person. It is exactly that,
and it is systematic — the same phone appears once from the funnel and once from WhatsApp:

```
9354992661  2026-07-21  Converted  CGA Funnel - Sexologist Page  "Pankaj chauhan"
9354992661  2026-07-21  (blank)    Wati                          "Pankaj Chauhan WATI"
```

The ` WATI` suffix is the tell. The merge rules in `mapping-legacy-to-target.md` §1.2 handle
this: match on `phone_e164`, keep the earliest row's attribution, strip the channel suffix from
the name.

## Columns worth importing

| Zoho column | target | note |
|---|---|---|
| `Record Id` | `customer_identities(system='zoho')` | makes the import idempotent |
| `Contact Number` / `Alternate Number` | `phone_e164` / `alt_phone_e164` | |
| `Customer Name` | `full_name` | strip trailing ` WATI` |
| `Email` (19%) · `Age` (21%) · `Gender` (25%) · `Address` (13%) · `State` (12%) | customers | address/pincode never cleaned |
| `Created Time` | `leads.created_at` | ISO already: `2023-01-18 13:37:12` |
| `Lead Source` | `leads.source_id` | 25 distinct, see below |
| `Lead Status` | `leads.status_id` | only 2 values, see below |
| `Diseases` (78%) | `concerns` | the real concern list |
| `Follow-up 1–4 Date / Remark / Done By` | `followups` rows | 10,516 / 6,470 / 3,191 / 732 filled |
| UTM + `Google Click Identifier` | `leads.utm_*` | sparse (2–5%) but free |

## Columns that look useful and are not

- **`Consultation Leads Owner`** — only 3 values, all system accounts:
  `CRM Kapeefit` 26,168 · `nishant` 22,773 · `CRM Patanjali` 3,236. **Useless as an owner.**
  The real attribution is in `Follow-up N Done By`.
- **`Payment Status`** — 28 rows out of 52,177. Effectively empty; payment was never tracked here.
- **`Lead Status`** — only `Need Followup` (29,691) and `Converted` (7,405); 29% blank.
- `Tag`, `Locked`, `Unsubscribed Mode`, `Change Log Time`, `Lead Insights` — Zoho internals, dropped.

## `Diseases` — the actual concern list (18 values)

Sexologist 27,926 · Ayurveda 7,999 · Gynecologist 2,818 · Menstrual Problem 713 ·
Sexual Problem 306 · Skin Problem 211 · Male Problem 119 · Infertility 106 · Diabetes 58 ·
Fever 53 · Stomach Problems 46 · Stomach Problem 45 · Hair Problem 40 · Arthritis 34 ·
Heart Diseases 32 · Other 12 · Male Problems 5 · Fatty Liver 1

Note the singular/plural duplicates: `Stomach Problem(s)` and `Male Problem(s)`.

## `Lead Source` — 25 values

Wati 14,688 · Elementor 11,857 · Justdial 6,158 · Kapeefit Website 4,913 · Facebook 3,607 ·
Click Funnels 3,137 · Wati Elementor 2,311 · CGA Funnel - Sexologist Page 1,348 ·
Instapage 960 · Wati Faceebook 839 · Offline Call 705 · Wati Product 362 · Direct Calling 352 ·
Others 318 · Google Ads 205 · ClickFunnels 137 · CGA Funnel - ED Page 85 · Typeform 67 ·
Wati Blog 65 · AI Chatbot 35 · Job 13 · Ecommerce 7 · Calling 5 · Website 2 · PMS LEAD 1

Obvious pairs to merge: `Click Funnels`/`ClickFunnels`, and `Wati Faceebook` (typo of Facebook).

## People found in `Follow-up N Done By`

Whole file: Anshu Chauhan 7,883 · Tripti Chauhan 3,360 · **Ashutosh Pal 2,122** ·
**Shreyansh 2,017** · Harshal Deep 1,435 · Nisha 1,341 · **Tejas 828** · Saloni Srivastava 817 ·
**Tejasv 536** · Ashutosh Saxena 230 · Varun Kumar 202 · Priyanka 20 · Prerna Agarwal 2

Inside the 12-month window: Shreyansh 2,017 · Ashutosh Pal 1,453 · Nisha 738 ·
Harshal Deep 433 · Tejas 99 · Tejasv 3 · Anshu Chauhan 1 · Ashutosh Saxena 1

**This is the blocker.** See open-questions Q31–Q33.

## `Gender` needs normalising (30 variants)

Male 6,526 · male 2,692 · Female 2,281 · MALE 1,158 · M 285 · female 148 · FEMALE 14 ·
Feamle 6 · Job 5 · Other 4 · Femal 4 · -Gender- 3 … Case-fold and map; anything unrecognised
imports as null rather than being forced into a bucket.
