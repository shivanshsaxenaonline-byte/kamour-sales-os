# Design brief — Kamour Sales OS

> **Superseded 2026-09-08 by `docs/astra-prompt.md`**, which is the paste-ready version:
> written as a prompt, updated with what is actually built, real bucket names, real Hinglish
> labels already in the code, real volumes, and synthetic sample rows.
> This file is kept for the reasoning behind the constraints.

You are designing the UI. Everything below the "Contract" section is fixed by engineering and
must not be redesigned. Everything in "What to design" is yours.

Read this whole file before drawing anything. It is self-contained — you do not need the
database schema.

---

## 1. What this is

An internal sales CRM, used as a **Windows desktop app**, by 3 sales executives, 1 sales
manager, doctors, a COO and a CEO at an Ayurvedic men's wellness brand in Bareilly, UP.
Scaling to ~15 users.

It replaces Zoho CRM plus nine Google Sheet tabs. The people using it currently live in a
spreadsheet all day.

**Definition of done:** a sales executive works a full day without opening Google Sheets.
If they still open the sheet, the design failed, regardless of how it looks.

This is an **8-hour-a-day operations tool, not a landing page.** Density and calm over
decoration. Reference feel: Linear, Height. Not: a generic shadcn dashboard demo.

---

## 2. The one problem the product exists to solve

In July: **415 people completed a doctor consultation. 93 placed a new order.**
About 322 people spoke to a doctor and then vanished.

Making those people visible and followable is the product's main job. Any screen that does not
help a rep act on a specific person today is secondary.

---

## 3. Contract — fixed, do not redesign

### 3.1 Tokens

```css
--bg:        #F7F8FA;   /* app background */
--surface:   #FFFFFF;
--border:    #E3E7ED;
--border-str:#C9D1DB;   /* table rules, focus */
--text:      #1A2231;
--text-dim:  #667080;
--accent:    #1E5EFF;   /* the single accent: selection, focus, primary button */

/* semantic — these map to real business states and are used nowhere else */
--paid:  #0E6B57;  --paid-bg:  #DCEFE9;
--pend:  #9C5F14;  --pend-bg:  #F7EAD6;
--stop:  #96292A;  --stop-bg:  #F5DEDE;
```

One accent. The three semantic colours mean paid / pending / stopped-or-failed and may not be
borrowed for decoration.

Dark mode is required, same tokens inverted — sales floors run late. Design both.

### 3.2 Type
- Inter or Public Sans. **13px base** — this is a dense tool, not 16px marketing.
- **All numbers, IDs, dates and phone numbers: `font-variant-numeric: tabular-nums`.**
  Non-negotiable. Columns must align vertically when scanned.
- Weights: 400 body, 500 labels, 600 headings. **Never 700 in a table.**

### 3.3 Density
- Table row height **32px**. Header row **36px**. Cell padding `6px 10px`.
- A 13" laptop must show **20+ rows without scrolling**. Design at 1366×768 first, not 1920.
- Status is a **small text pill**, never a coloured row background. Coloured rows destroy
  scanability.

### 3.4 Interaction
- **Keyboard first.** `j`/`k` row nav · `Enter` open · `e` edit · `/` search · `Esc` close ·
  `Ctrl+K` command palette. Every one of these needs a visible design state.
- **Optimistic updates** — the UI moves instantly, the server confirms after; on failure it
  rolls back and shows a toast. Design the rollback state.
- **Zero full-page spinners.** Skeleton rows only.
- Every destructive action is **undoable for 10 seconds via a toast**, never a confirm dialog.
- Transitions ≤150ms or none. Respect `prefers-reduced-motion`.

### 3.5 Language
UI labels are **Hinglish in Latin script**: "Aaj Ka Kaam", "Follow-up baaki", "Order banao",
"Paid", "Unpaid", "Kal", "Aaj". Data, code and column headers in English.
Write the actual Hinglish label in every mockup — no `[Label]` placeholders.

### 3.6 Rejected by default
Gradient headers · glassmorphism · oversized hero numbers · a decorative icon in every cell ·
card grids where a table belongs · purple-blue SaaS gradient · emoji as UI · rounded-2xl
everything · drop shadows on table rows · a sidebar that takes 280px.

---

## 4. What to design

### 4.1 App shell
Desktop window. Left nav, main region. Nav holds: **Aaj Ka Kaam** (default), Leads,
Consultation, Orders. Plus a user/role area. Manager and CEO see extra items — design the nav
so adding items later does not require rethinking it.

Needed: collapsed and expanded nav, the active state, and where a live-connection / presence
indicator sits.

### 4.2 Aaj Ka Kaam — the home screen, most important artifact

**Not a set of tabs. One priority queue across every source.** A rep opens the app and works
top to bottom without deciding what to do next.

The ranking, fixed:
1. SLA breach (a lead not responded to in time)
2. Paid lead (they paid ₹99, they are waiting)
3. RRR due (a repeat pitch is due today)
4. Follow-up due
5. Unpaid lead

Design questions that are yours to answer:
- How does a row show *why* it is at the top, without a colour-coded row?
- Do the five buckets get visible separators, or does the list just flow?
- What does an empty queue look like at 6pm? (This should feel like a win, not an error state.)
- What does the row look like after it has been actioned but before it disappears?

Each row must carry: person's name, phone, what is due, how overdue, and the one action.

### 4.3 The grid — one component, reused by every module

This is the workhorse. Design it once, thoroughly:
- header, sortable column, sorted column
- normal row · hovered · keyboard-focused (`j`/`k`) · selected · multi-selected
- inline edit: cell entering edit, valid, invalid, saving, save failed and rolled back
- bulk selection bar (appears when ≥1 row is selected)
- column show/hide control, saved filters
- skeleton rows while loading
- **soft row lock**: another rep started a call on this row (10 min lock) — the row must read
  as unavailable without shouting
- **presence badge**: who else is looking at this row right now
- a row updating live because someone else changed it — how does it announce itself without
  the list jumping under the reader's cursor?
- row expanded to show the full record (list rows carry summary columns only; the full record
  loads on expand — this is an engineering constraint, but it makes the expand a real design
  problem)

### 4.4 Modules — the same grid with different tabs

| Module | Tabs |
|---|---|
| **Elementor Leads** | Paid · Unpaid · Junk. Paid always sorts above unpaid. "Order banao" button lives here. |
| **Consultation** | Paid · Unpaid · Cancelled · Done today. Cancelling requires a mandatory reason. |
| **Orders** | Pending confirm · Confirmed · Dispatched · Delivered · RTO |

Design the tab bar with counts, and one populated example per module.

### 4.5 Forms and dialogs
- **"Order banao"** — the order creation form. It has address, pincode, amount, discount,
  product lines and course duration. **Every one of those fields is typed by a human and is
  never auto-filled** — one wrong character in a pincode is a returned shipment and lost
  money. Design these fields to be read back and checked, not breezed through.
  Product lines are repeatable rows, not a fixed set of fields.
- Mandatory-reason dialog (cancel a consultation, mark a lead lost).
- Command palette (`Ctrl+K`).
- Toast: success · error with rollback · destructive-with-undo (10s, with the timer visible).

### 4.6 Small but load-bearing
- **Status pills** — a full set: Paid, Unpaid, Pending, Confirmed, Dispatched, Delivered, RTO,
  Cancelled, Junk. Using only the three semantic colour pairs plus neutrals. This is a real
  constraint: eight-plus states, three colours. Solve it with weight and border, not new hues.
- **Masked phone** — `98••••4773`, shown for leads not assigned to the viewer. Design how a
  rep understands "this is not yours yet" and what claiming it looks like.
- Overdue indicator — "3 din se pending" needs to be legible at a glance in a 32px row.
- Empty states for each module.
- The Tauri desktop window: title bar treatment, minimum window size.

---

## 5. What NOT to design (out of scope)

Telephony or call recording · any AI or "suggested" field · charts and analytics dashboards ·
a mobile layout · marketing or login-page branding beyond a plain sign-in · WhatsApp inbox
(later phase) · manager cockpit (later phase).

There is **no AI in this product yet**. Do not design sparkle icons, "AI suggests", or
assistant panels. When AI does arrive it will produce a draft in a highlighted field that a
human confirms before saving — so if you want to leave room for one visual affordance, make it
"this field holds an unconfirmed draft". Nothing more.

---

## 6. Deliverables

In this order — 1 and 2 are what unblock the build:

1. **The grid**, every state listed in §4.3, light and dark.
2. **Aaj Ka Kaam**, populated with ~20 realistic rows (real-looking Indian names, +91 numbers,
   ₹ amounts, Hinglish labels).
3. Elementor Leads / Consultation / Orders, one populated screen each.
4. "Order banao" form, plus the dialogs and toasts.
5. Status pill set, masked phone, empty states.
6. A one-page spec sheet: exact px for row height, header height, cell padding, font sizes,
   border widths, focus ring, pill dimensions, and the dark-mode token values you chose.

**Format:** whatever you work in — Figma, HTML/CSS, or annotated images. If HTML, use the CSS
custom properties above by name so the values can be lifted directly. If Figma, name the
variables to match the token names.

The engineering side is Next.js 15 + Tailwind + shadcn/ui. Designs that fight shadcn's
primitives are fine — but say so explicitly, so the component gets rebuilt rather than
approximated.

---

## 7. How to tell if it worked

- A rep can process a row without moving their hand to the mouse.
- 20+ rows visible on a 13" screen with nothing feeling cramped.
- Someone can tell paid from unpaid across a 50-row list in under a second.
- Nothing on screen exists only for decoration.
