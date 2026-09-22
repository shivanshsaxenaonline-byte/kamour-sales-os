# RRR cutover — 14 September 2026

Production: https://kamour-sales-os.vercel.app (Vercel deployment `dpl_9caUVWwWn89ENX3zNRYHhQYxcY5c`). The RRR screens read the live Supabase database. The team's KM002 AI Daily Queue was imported from a snapshot taken at 16:52 IST; future edits to that tab do **not** sync automatically. From cutover, reps should log calls in the dashboard.

## Data reconciled

- The 9–14 September AI Queue added 288 dated follow-up records. A strict match across a two-phone Master cell, its source row, order date, and amount recovered 87 more historical follow-ups that the original single-phone importer had rejected. A dry-run after both imports added zero records.
- 99 valid promised next dates became pending order follow-ups. There are 167 pending order follow-ups in Supabase after the import.
- All 40 AI Queue rows with an outcome but no call timestamp are completed on their Selection Date at midnight IST, with `Completed on selection date; exact call time not recorded in sheet` in the remark. The 40-row source-to-DB audit matched all 40.
- The exact Master Sheet order at row 1847, whose actual delivery is 6 September, was corrected from confirmed/no delivery to delivered in Supabase. No estimated date was substituted for an actual delivery.
- Today's AI list was regenerated from the updated history: 45 customers, 15 each for Ashutosh, Shreyansh, and Tejasv. Unworked carry-over is capped at nine per rep.

## Why Medicine Ending differed

`/rrr/medicine-ending` reads delivered Supabase orders with an actual delivery timestamp and a 15- or 30-day course. It does not read the KM002 Master tab directly or promote estimated delivery dates to actual. In the supplied Master tab, most orders have estimated delivery or no course length; they cannot honestly enter this list. There are currently 142 delivered 15/30-day orders in Supabase.

The app and several RRR SQL calculations used UTC calendar dates for timestamps recorded at IST midnight. This put 135 of those 142 delivery dates on the previous day when cast in UTC, and shifted course-ending bands. The app now converts timestamp to IST before computing delivery and end dates. RRR order, call, due, and AI scoring dates also use IST.

The Orders workspace does poll a **different** spreadsheet's `Medicine Order Record - AP+TA+S` tab while that module is open, every two minutes. The KM002 Master/AI tabs are not wired to that sync. The current AI Queue import is the handoff of historical records, not an ongoing connector.

## Remaining source exceptions

115 older AI Queue rows remain in `import_rejects`: 92 shifted/corrupt columns, 13 invalid phones, seven customers with no order to attach, and three customers absent from the database. None has a Selection Date of 9–14 September. Review `exports/rrr-ai-queue-exceptions-2026-09-14.csv` before manually supplying missing identities or orders; do not attach these calls to unrelated orders.

Supabase's security advisor separately flags the existing `v_pool_leads` security-definer view. This predates the RRR fixes; RRR views use `security_invoker`, and the role-isolation tests pass.

## Verification and recovery

Production build, login/redirect HTTP checks, 21 AI list tests, eight call logging tests, the assigned-AI-rep isolation test, and 27 general RLS tests passed. The live production alias resolves to deployment `dpl_9caUVWwWn89ENX3zNRYHhQYxcY5c`. The pre-write database backup is in `backups/2026-09-14T11-03-21`.

The 14 September migrations are `20260914111114`, `20260914111805`, `20260914112015`, and `20260914113108`, each with a down file. The importer is repeatable with `--file`, `--master-file`, and `--schedule-from`, and should be dry-run before a later catch-up.
