# Prompt for Astra (ChatGPT) — copy everything below the line

Paste the whole block into a new ChatGPT conversation. It is self-contained: Astra needs no
access to the repo or the database.

**Do not paste real customer data into ChatGPT.** The sample rows below are invented for exactly
this reason — real names and phone numbers stay in the database.

---

You are the product designer for an internal sales CRM called **Kamour Sales OS**. I am the
engineer. The backend is built and running against real data — 51,316 customers, 51,927 leads.
I need the visual design.

Deliver in **HTML + CSS** so I can lift your values directly, using CSS custom properties. If
you prefer Figma, name the variables to match the token names below exactly.

## What this is

A Windows desktop app (Tauri) used **eight hours a day** by 3 sales executives, 1 sales manager,
doctors, ops, a COO, a CEO and an auditor at an Ayurvedic men's wellness brand in India.
Scaling to ~15 users. **UI language is English.**

It replaces Zoho CRM and nine Google Sheet tabs. The people using it live in a spreadsheet all
day and are genuinely fast in it. If the new tool is slower to operate than the sheet, they will
go back to the sheet.

**Definition of done: a sales executive works a full day without opening Google Sheets.**

## The one problem the product exists to solve

In one month, 444 people completed a doctor consultation and only 168 placed an order.
**15,316 leads sit unassigned in a pool** nobody has called.

Making those people visible and actionable is the product's entire job. Any screen that does not
help a rep act on a specific human today is secondary.

## The look I want

**Modern, professional, premium.** Think Linear, Height, Vercel, Raycast — products that feel
expensive because of craft, restraint and precision, not because of decoration.

Get this tension right, because it is the whole brief:

> **Modern does NOT mean airy here.** Most "modern SaaS" defaults — 16px body text, generous
> padding, card grids, big section headers — would show 8 rows on a 13" laptop instead of 20+,
> and this team would abandon the tool. Linear is modern *and* dense. That is the target.

So: premium through **typography, spacing rhythm, colour discipline, border quality, considered
focus and hover states, real empty states** — never through gradients, shadows or size.

**Actively avoid:** purple-blue SaaS gradients · glassmorphism · gradient headers · oversized
hero numbers · a decorative icon in every cell · card grids where a table belongs · emoji as UI ·
`rounded-2xl` everywhere · drop shadows on table rows · a 280px sidebar · dashboards full of
widgets nobody reads.

**There is no AI in this product.** No sparkle icons, no "AI suggests", no assistant panel.

## Colour — this part is yours, and I want your best work

The current palette is functional but plain. **Propose a better one.** It must:

1. Work fully in **light and dark**. Both are shipped; sales floors run late. Design both.
2. Use **one primary accent** for selection, focus and primary actions. Not three.
3. Include **exactly three semantic pairs** (foreground + background) that map to real business
   states and are used nowhere else:
   - **positive** — paid, delivered, confirmed
   - **attention** — pending, awaiting payment, due soon
   - **critical** — failed, RTO, cancelled, SLA breach
4. Hit **WCAG AA (4.5:1)** for text on its background, in both themes. State the ratios.
5. Be legible on a cheap, uncalibrated office monitor — subtle greys that look elegant on a
   MacBook can disappear entirely on a ₹8,000 screen. This matters more than it sounds.
6. Stay calm at high density. A colour that is pleasant once becomes noise repeated 40 times
   down a column.

For reference, the current tokens (replace them with something better, keep the structure):

```css
--bg: #F7F8FA;  --surface: #FFFFFF;  --border: #E3E7ED;  --border-str: #C9D1DB;
--text: #1A2231;  --text-dim: #667080;  --accent: #1E5EFF;
--paid: #0E6B57;  --paid-bg: #DCEFE9;
--pend: #9C5F14;  --pend-bg: #F7EAD6;
--stop: #96292A;  --stop-bg: #F5DEDE;
```

Give me the full token set for both themes, with hex values and contrast ratios.

## Fixed constraints — already implemented, do not redesign

- Font: Inter or similar. **13px base.** Not 16px.
- **Every number, ID, date and phone uses `font-variant-numeric: tabular-nums`.**
  Non-negotiable — columns must align when scanned vertically.
- Weights: 400 body, 500 labels, 600 headings. **Never 700 in a table.**
- Table row **32px**, header **36px**, cell padding **6px 10px**.
- **20+ rows visible on a 13" laptop. Design at 1366×768 first, not 1920.**
- Status is a **small text pill**, never a coloured row background — coloured rows destroy
  scanability.
- **Keyboard first**: `j`/`k` row nav · `Enter` open · `e` edit · `/` search · `Esc` close ·
  `Ctrl+K` command palette. Each needs a visible state.
- **Optimistic updates** — UI moves instantly, server confirms after, rolls back with a toast on
  failure. Design the rollback.
- **No full-page spinners.** Skeleton rows only.
- Destructive actions are **undoable for 10 seconds via a toast**, never a confirm dialog.
- Transitions ≤150ms or none. Respect `prefers-reduced-motion`.

## What already exists

A working shell: 184px left nav (wordmark, role-filtered links, user block, theme toggle,
logout) and a scrolling main region. Routes: **Today**, **Leads**, **Consultations**, **Orders**.
Improve it if you can — just tell me what changed.

## What to design

### 1. The grid — the most important thing here

One component, reused by every module. A rep stares at it for eight hours. Every state:

- header · sortable column · sorted column
- row: normal · hover · **keyboard-focused** (`j`/`k`) · selected · multi-selected
- inline edit: entering edit · valid · invalid · saving · **save failed and rolled back**
- bulk-selection bar (appears at ≥1 row selected)
- column show/hide · saved filters
- **skeleton rows** while loading
- **soft row lock** — another rep started a call on this row (10-minute lock). Must read as
  unavailable without shouting.
- **presence badge** — who else is viewing this row right now
- a row updating live because someone else changed it — how does it announce itself **without
  the list jumping under the reader's cursor?**
- row expanded to the full record (list rows carry summary columns only; the full record loads
  on expand — an engineering constraint that makes the expand a real design problem)

### 2. Today — the home screen

**Not tabs. One priority queue across every source.** A rep opens the app and works top to
bottom without deciding what to do next. Buckets are mutually exclusive — one person, one row:

| rank | bucket | meaning |
|---|---|---|
| 1 | SLA breach | lead not answered within 15 minutes |
| 2 | Paid lead | paid ₹99 and is waiting |
| 3 | Repeat due | repeat-order pitch is due today |
| 4 | Follow-up due | a follow-up is due |
| 5 | Unpaid | unpaid, never contacted |

Yours to answer:

- How does a row show **why** it is at the top, without colouring the row?
- Do the five buckets get visible separators, or does the list flow?
- What does an **empty queue at 6pm** look like? It should feel like a win, not an error.
- What does a row look like **after** it is actioned but before it disappears?

Each row carries: name, phone, what is due, how overdue, and the one action.

Real volumes: one rep has **182 items**, another **19**, another **0**. The manager sees the
whole team. Design for all three — the empty one is a real screen someone sees every evening.

### 3. Modules — same grid, different tabs

| module | tabs |
|---|---|
| **Leads** | Paid · Unpaid · Junk (paid always sorts above unpaid). "Create order" button lives here. |
| **Consultations** | Paid · Unpaid · Cancelled · Done today. Cancelling requires a mandatory reason. |
| **Orders** | Pending confirm · Confirmed · Dispatched · Delivered · RTO |

Tab bar with counts, plus one populated screen each.

### 4. Forms and dialogs

- **Create order** — address, pincode, amount, discount, product lines, course duration.
  **Every one is typed by a human and never auto-filled** — one wrong character in a pincode is
  a returned shipment and lost money. Design these to be **read back and checked**, not breezed
  through. Product lines are repeatable rows.
- Mandatory-reason dialog (cancel a consultation, mark a lead lost)
- Command palette (`Ctrl+K`)
- Toasts: success · error with rollback · destructive-with-undo (10s, timer visible)

### 5. Small but load-bearing

- **Status pills**, full set: Paid, Unpaid, Pending, Confirmed, Dispatched, Delivered, RTO,
  Cancelled, Junk. **Nine states, three semantic colours** — solve it with weight, border and
  fill, not new hues. This is the hardest small problem here.
- **Masked phone** — `98••••4773` for leads nobody has claimed. How does a rep understand "this
  is not mine yet"? What does claiming it look like?
- **Overdue indicator** — "3d overdue", legible at a glance inside a 32px row
- Empty states per module
- Tauri desktop window: title bar treatment, minimum window size

## Sample data for mockups (invented — not real customers)

```
Today
SLA breach      Rohit Verma      +919876543210   2 min    Call now
Paid lead       Imran Sheikh     +919812345678   18 min   Paid — book consultation
Repeat due      Suresh Nair      +919900112233   D+11     Pitch the repeat order
Follow-up due   Mahesh Patil     +919765432109   3d       Follow up
Unpaid          Arun Kumar       98••••4773      1d       Unpaid — follow up

Orders
KM-1042  Rohit Verma    ₹2,985  Dispatched  GPay + COD  Delhivery    15d
KM-1043  Imran Sheikh   ₹5,495  Delivered   Razorpay    Shiprocket   30d
KM-1044  Suresh Nair    ₹1,095  Pending     COD         —             7d
```

Products: Gold Plus 60N/30N · Daily Charge 60N/30N · Power Drive · Boost Up Oil ·
Shilajit Gold Resin · 7-Day Booster Combo. Prices ₹591–₹5,495.
Couriers: Delhivery, Shiprocket, Bluedart, DTDC.

## Deliverables, in order

1. **Colour system** — full token set, light and dark, hex values, contrast ratios, and a
   swatch sheet showing the nine status pills in both themes
2. **The grid**, every state above, light and dark
3. **Today**, populated with ~20 rows
4. Leads / Consultations / Orders — one populated screen each
5. Create-order form, dialogs, toasts
6. Masked phone, empty states, overdue indicator
7. **A one-page spec sheet**: exact px for row height, header height, cell padding, font sizes
   and weights, border widths, radii, focus ring, pill dimensions

**Do 1 and 2 first and show me before continuing** — they unblock my build, and if the colour
system is wrong everything after it is wasted.

## How we will know it worked

- A rep processes a row without moving their hand to the mouse
- 20+ rows on a 13" screen without feeling cramped
- Paid vs unpaid distinguishable across a 50-row list in under a second
- It looks like a product someone chose, not one they were assigned
- Nothing on screen exists only for decoration

Engineering: Next.js 15 + Tailwind + shadcn/ui. If a design fights shadcn's primitives, that is
fine — say so explicitly so I rebuild the component rather than approximating it.

**Ask me questions before designing if anything is ambiguous.** I would rather answer three
questions now than receive a beautiful screen that solves the wrong problem.
