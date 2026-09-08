# Brief for Codex — paste everything below the line

**Corrected 2026-09-08:** "Astra" is the model running inside Codex (GPT-6 Astra), not a separate
agent. Codex therefore owns **both** the visual design and the frontend code. There are two
agents on this project, not three:

| agent | owns |
|---|---|
| **Claude** | database, migrations, RLS, imports, data layer, wiring |
| **Codex (GPT-6 Astra)** | colour system, visual design, all UI components and module pages |

The design prompt is `docs/astra-prompt.md`; this file is the engineering half of the same brief.
The division below exists so the two agents do not overwrite each other.
**There is no version control yet, so an overwrite is permanent.**

---

You are working on **Kamour Sales OS**, an internal sales CRM. Another agent owns the database,
migrations and data imports. You own application code only. Read this fully before editing.

## Ground rules — read these first

**Never touch these. They are live and already applied:**

| Path | Why |
|---|---|
| `supabase/migrations/**` | 21 numbered migrations, all applied to the production database. Editing an applied migration silently desynchronises the schema. If you need a schema change, **write it in a comment and tell me** — do not create a migration file. |
| `scripts/**` | Importers that have already run against real data (51,316 customers). Re-running a modified one can duplicate or destroy rows. |
| `.env.local` | Live credentials, including a service-role key. Never read it into code, never print it, never commit it. |
| The database itself | Do not run SQL. Do not connect. Do not `npm run db:*`. |
| `data/incoming/**` | Real customer data. Never open, never paste anywhere. |
| `PROJECT.md`, `docs/decisions.md` | Shared source of truth, maintained by the other agent. |

**You own:**

- `src/components/**` — all UI components
- `src/app/(app)/leads`, `/consultations`, `/orders` — module pages
- `src/lib/**` except `src/lib/supabase/*` (those two clients are settled; use them, don't edit)
- `src/types/**` — you may add types
- Tests

If a task needs something outside your area, **say so and stop** rather than reaching into it.

## What the app is

A Windows desktop app (Tauri) used eight hours a day by ~15 people at an Ayurvedic wellness
brand: sales execs, a manager, doctors, ops, COO, CEO, auditor. It replaces Zoho CRM and nine
Google Sheet tabs. UI language is **English**.

**Definition of done: a sales executive works a full day without opening Google Sheets.**
If the tool is slower to operate than the spreadsheet, they go back to the spreadsheet.

Stack, locked — do not substitute: Next.js 15 App Router · TypeScript strict · Tailwind ·
shadcn/ui · **TanStack Table + TanStack Virtual** for the grid · TanStack Query for server
state · Supabase (Postgres + RLS + Realtime) · Tauri v2.

## Hard constraints that will get code rejected if broken

### 1. Egress is the binding limit

The Supabase free tier allows 5 GB/month, pooled. A previous project burned 184 MB/day with
four users. These are rules, not preferences:

- **Never `select *`.** Name every column explicitly.
- Every list is paginated — default 50, always `.range(from, to)`.
- List views fetch summary columns only. The full record loads on row expand.
- Realtime subscribes to **filtered** channels (own rows), never a whole table.
- **Zero polling.** No `setInterval` fetching, ever. Use Realtime.
- Never select `raw_payload`, `notes`, `body` or `payload` in a list query — they are large and
  the narrow views exist specifically to keep them out.

Prefer the existing database views, which already enforce the column discipline:
`v_aaj_ka_kaam` (the Today queue), `v_leads_list`, `v_consultations_list`, `v_orders_list`,
`v_pool_leads`.

### 2. Row-level security is real

Every table has RLS enabled and forced. A sales exec genuinely cannot read another exec's rows —
proven by a 27-assertion test suite. So:

- Do not add client-side filtering "for security". It is already enforced in the database.
- If a query returns nothing, the cause is usually RLS, not a bug. Say so rather than working
  around it.
- Never use the service-role key in application code. It bypasses RLS entirely.

### 3. Fields that are never auto-filled — ever

`address`, `pincode` (one wrong character is a returned shipment and lost money) · `amount`,
`discount` (money) · `order_items`, `quantity` (this is a prescription) ·
`course_duration_days` (drives the repeat-order clock).

No default values, no "smart" prefill, no copying from a previous order. A human types each one.

### 4. There is no AI in this product

No sparkle icons, no "AI suggests", no assistant panel, no LLM calls.

### 5. Dates

`node-postgres` and JS `Date` will shift a Postgres `date` by the IST offset and report the
previous day. Never build a display date via `.toISOString()`. Treat `date` columns as strings.
A one-day error in the repeat-order clock silently misses the revenue event the product exists
to catch.

## Design constraints (you produce these yourself — see `docs/astra-prompt.md`)

- **13px base.** Not 16px.
- Table row **32px**, header **36px**, cell padding **6px 10px**.
- **20+ rows visible on a 13" laptop at 1366×768.**
- **Every number, ID, date and phone: `font-variant-numeric: tabular-nums`.** Non-negotiable.
- Weights: 400 body, 500 labels, 600 headings. Never 700 in a table.
- Status is a small text pill, never a coloured row background.
- Use the CSS custom properties in `src/app/globals.css` (`var(--accent)`, `var(--paid)` …).
  **Never hardcode a hex value.** The palette is being replaced wholesale; anything hardcoded
  will break.
- Keyboard first: `j`/`k` row nav · `Enter` open · `e` edit · `/` search · `Esc` close ·
  `Ctrl+K` command palette.
- Optimistic updates — UI moves instantly, rolls back with a toast on failure.
- No full-page spinners. Skeleton rows only.
- Destructive actions undoable for 10s via toast, never a confirm dialog.
- Transitions ≤150ms or none. Respect `prefers-reduced-motion`.

## Your first task

Checkpoint 1 (colour system + grid prototype) is delivered in
`docs/design/astra-phase-1/` and has been reviewed. Next: turn that prototype into the **real
shared grid component** in the app — the component every module reuses.

`src/components/grid/` :

1. **Virtualization** via TanStack Virtual. Must stay smooth at 50,000 rows — the leads table
   really has 51,927.
2. **Keyboard navigation**: `j`/`k` move, `Enter` opens, `e` edits, `Esc` closes, `/` focuses
   search. Focus must be visible and must not scroll-jump.
3. **Inline edit state machine**: idle → editing → saving → saved, and → failed → rolled back.
   Optimistic: the cell shows the new value immediately, reverts on error with a toast.
4. **Selection**: single, shift-range, select-all-visible. A bulk bar appears at ≥1 selected.
5. **Column show/hide**, persisted per user in `localStorage`.
6. **Skeleton rows** while loading — never a spinner.
7. **Live update handling**: when a row changes underneath the reader, the list must not jump
   under the cursor. Design this explicitly and document what you chose.

Typed generically so leads, consultations and orders all use it. No data fetching inside the
grid — it takes rows as props. Fetching lives in TanStack Query hooks.

## Verify before you say you are done

```
npx tsc --noEmit        # must be clean; strict mode, noUncheckedIndexedAccess is on
npx next build          # must pass
```

Do not disable a TypeScript rule to make an error go away. Do not add `any`. If the types are
genuinely fighting you, say so.

## How to report back

Tell me what you changed, file by file. If you hit something in the other agent's area — a
schema change, a policy problem, an import question — **stop and describe it** rather than
working around it. A workaround in application code for a database problem is how a schema
quietly rots.
