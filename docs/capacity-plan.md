# capacity-plan.md — what actually fits in the free tier

Measured 2026-09-08 against the live project, not estimated.

## Real row sizes (data only, from `pg_column_size`)

| table | bytes/row | with indexes (~2.2x) |
|---|---|---|
| customers | 214 | ~470 |
| consultations | 152 | ~335 |
| followups | 187 | ~410 |
| orders | 350 | ~770 |
| order_items | 88 | ~195 |
| customer_identities | ~70 | ~150 |

The `pg_total_relation_size` figures (965 B/customer etc.) are misleading at 500 rows — every
index has a fixed minimum. The numbers above are the ones that hold at scale.

## Free plan limits

| resource | free | note |
|---|---|---|
| **Database** | **500 MB** | the one that matters for row count |
| Storage (files) | 1 GB | backups live here |
| Egress | 5 GB / month | pooled org-wide; the binding limit per PROJECT.md |
| — | — | project pauses after 7 days of no activity |

Supabase Pro ($25/mo, planned for launch) raises these to 8 GB database and 250 GB egress.

## What each import option costs

| option | rows | database used |
|---|---|---|
| Last 12 months | 11,728 leads + ~11,000 customers + ~21,000 follow-ups | **~21 MB** |
| Last 24 months | ~25,000 leads | ~45 MB |
| Everything | 52,177 leads | **~95 MB** |

Against a 500 MB limit. **Even importing all 52,177 rows uses under 20% of the free tier.**

## Growth

Leads per month from the Zoho export (last 12 months): average **977/month**, trending up —
Jun 2026: 1,490 · Jul: 1,409 · Aug: 1,474. (May 2025's 10,734 is a one-off bulk load, ignored.)

At **1,200 leads/month**, each producing roughly one customer, one lead, ~1.8 follow-ups, plus
the consultation and order flow:

**≈ 2.5 MB per month.**

| after importing | used | free tier headroom |
|---|---|---|
| 12 months | ~35 MB | 465 MB ÷ 2.5 = **~15 years** |
| everything | ~110 MB | 390 MB ÷ 2.5 = **~13 years** |

Storage will not be the thing that forces an upgrade.

## What WILL force the upgrade: egress

Egress is about **reading**, not storing. PROJECT.md measured 184 MB/day with 4 users against
5 GB/month — that alone is 5.5 GB/month, already over.

Crucially, **egress barely depends on how many rows are stored.** A paginated list fetching 50
rows through a narrow view costs the same whether the table holds 500 rows or 500,000 — that is
exactly why the hard constraints (never `select *`, always `.range()`, narrow views, filtered
Realtime) exist. Import size is close to irrelevant here.

## Conclusion

Row count is not a cost question. Choose the import window on **usefulness**:

- A 3-year-old lead that never converted still shows up in the pool, in segment C2, and in
  every unfiltered count.
- Nothing is destroyed either way — the rows not imported are archived as CSV and can be loaded
  later from `data/incoming/zoho/`.

Recommendation stands at **12 months**, for signal quality rather than space. Going wider is
safe if the team actually wants to work those older leads.
