# Kamour Sales OS — Astra review 01

Open **[index.html](./index.html)** directly in a desktop browser. No install, build, server, or credentials are required. Start at a **1366 × 768 content viewport**, 100% zoom. A browser's own toolbar reduces the available height if the whole window, rather than the content viewport, is 768px tall.

This is the first review checkpoint requested in [astra-prompt.md](../../astra-prompt.md): **colour system and reusable grid**. Today, module screens, order creation and the remaining dialogs follow after this review. All 50 records are synthetic; interactions and delays are local simulations. No existing app files or database records were changed.

> **Patch (Claude, same day):** the prototype rendered in the fallback system font (Segoe UI)
> because no web font was ever loaded — `tokens.css` names Inter but nothing links it — and it
> used zero icons anywhere, which together read as unstyled rather than as the intended flat,
> restrained density. Added a Google Fonts link for Inter and a small hand-drawn stroke-icon set
> (same visual language as `lucide-react`, shadcn/ui's default, for production parity) in the
> nav, toolbar, dialogs, empty state, and the lock/presence/expand affordances in each row.
> **This does drop the "no internet connection required" property** stated above — the font now
> loads from `fonts.googleapis.com`. If that matters for how this gets reviewed, swap in a
> self-hosted Inter woff2 instead of the CDN link. No colour token, contrast pair, row geometry,
> pill markup, or interaction logic was touched — `verify-contrast.mjs` still reports 46/46 pass
> with identical ratios. Diff is additive: font link, icon markup/CSS, and the brand mark.



## Open and review

The left navigation contains:

1. **Colour system** — both palettes, nine status pills in each theme, hex values and calculated text contrast.
2. **Interactive grid** — 50 records, keyboard controls and local interaction simulations.
3. **All grid states** — pinned specimens in both themes, including transient edit/loading/rollback states.
4. **Handoff notes** — exact dimensions, shell changes and production implementation contracts.

Use **Switch to dark** to evaluate the interactive grid in the second theme. The colour and state sheets always show both themes.

## Try these flows

| Action | How to review |
|---|---|
| Row navigation | Focus the grid, then `j` / `k`. The focused row has an accent perimeter. |
| Open / close | `Enter` expands the focused record, showing a local skeleton before details; `Esc` closes. |
| Inline edit | `e` edits Owner. Type `Ananya`, `Riya` or `Dev`, then Enter. Invalid or empty input stays editable with explicit guidance. |
| Save rollback | **Try a state → Fail the next owner save**. Change the owner and save. The original value returns; Retry preserves the attempted value. |
| Selection | Space or checkboxes. Select several rows; the bulk toolbar replaces the normal toolbar without adding height. |
| Undo | Bulk **Archive**, then **Undo** within the visible 10-second countdown. |
| Columns / saved views | **Columns** hides optional columns. The adjacent dropdown contains saved filter presets. |
| Search | `/` focuses search. Search a name, visible phone or record ID. Unknown text produces an actionable empty state. |
| Soft lock | Suresh Nair is in a simulated 10-minute call lock after reset. Read the record; selection and owner editing are unavailable. |
| Presence | Imran Sheikh shows a neutral **Dev viewing** badge. |
| Live update | **Try a state → Receive a teammate’s update**. The focused row updates without moving. **Apply sort** explicitly refreshes ordering and filter membership. |
| Loading / failure | **Try a state** contains list skeletons and record-expansion failure with inline Retry. |
| Commands | `Ctrl+K` opens searchable commands; Tab and Enter activate a result. |
| Start again | **Try a state → Reset demo** restores the original sample data. Reload also resets local state. |

## Files to use

- [tokens.css](./tokens.css): complete colour and geometry tokens, preserving the existing token names.
- [review.css](./review.css): grid, pill, input, outline, toolbar and expansion styles.
- [review.js](./review.js): demonstration behaviour and review sheets; not a production data layer.
- [contrast-report.md](./contrast-report.md): reproducible, unrounded-pass contrast audit.
- [interaction-report.md](./interaction-report.md): DOM/event verification results and explicit limitations.

Regenerate the colour audit from the workspace root:

```powershell
node docs/design/astra-phase-1/verify-contrast.mjs
```

## Design decisions

The neutral palette uses graphite and paper; cobalt is reserved for focus, selection and primary actions. Positive, attention and critical each have exactly one foreground/background pair. Paid is filled and semibold, Unpaid is outlined and regular. Dispatched is neutral progress; Junk is a neutral dashed pill. Generic errors, presence and validation use neutral labels so business-state colours keep their meaning.

The 184px sidebar stays. On grid routes, remove the existing main region's 16px gutter and use a 40px toolbar, 36px table header and 24px footer beneath a 28px desktop title strip. That leaves exactly 640px for twenty 32px summary rows at the target viewport. Expanded records intentionally consume extra height. Smaller windows and display scaling show fewer rows.

This requires overriding shadcn's default cell spacing, row hover and pill sizing. Retain the existing TanStack stack when integrating. Server-authoritative locks, version-conflict handling, authorization, reversible archive operations and filtered realtime remain production responsibilities.

## Verification boundary

The colour audit checks 46 foreground/background combinations, including interactive boundaries. Text passes at ≥4.5:1 and control boundaries at ≥3:1 under the [W3C contrast definitions](https://www.w3.org/TR/WCAG22/#contrast-minimum).

Browser discovery returned no available browsers in this session. DOM/event checks do not establish real rendered row heights, native dialog focus trapping, screen-reader behaviour, screenshot quality or full WCAG conformance. Those checks remain pending. The 20-row claim is an explicit CSS height budget, not an observed browser measurement.

## Requested checkpoint

From `docs/astra-prompt.md`: “Do 1 and 2 first and show me before continuing.” Review the palette, the density and the interaction states in this artifact before proceeding to the Today screen and module designs.
