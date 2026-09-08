# Reviewed UI integrated into Kamour Sales OS

The real application runs at **http://localhost:3000**. Sign in with an existing CRM account. The static review on port 4173 is a separate prototype; it does not show live records.

## Implemented

- Reviewed light/dark palette, 184px sidebar, 13px Inter, stroke icons and compact shell. Inter is bundled locally (48,256 bytes), with its OFL license; runtime font downloads are unnecessary.
- Today, Leads, Consultations and Orders use the same generic TanStack Table v9 + TanStack Virtual grid.
- Paginated Supabase reads from the existing narrow views, 50 rows per page, named columns, stable secondary ordering, server-side search and tab counts. The grid itself does not fetch data.
- J/K navigation, Enter to expand, E to edit, Escape to close, / search and Ctrl+K navigation. Single, Shift-range and page selection; the selection toolbar replaces existing toolbar space.
- Per-user local column visibility and saved search/tab/sort preferences. Orders hides Phone initially to leave enough space for customer names; it remains available in Columns and record details.
- Record expansion fetches additional fields only when requested. Orders loads its product lines separately. Loading and failure remain inside the relevant grid or record panel.
- Version-checked edits to non-destructive lead status, order AWB, consultation notes and follow-up remarks. Mutations update local presentation immediately and restore the previous snapshot on failure. Drafts survive virtualization in the in-memory query cache. After a version conflict, Reload record fetches the current version while retaining the draft.
- The existing Supabase server client authenticates every write and checks the active database role before updating. RLS remains authoritative. Zero-row updates are treated as conflicts or access failures, not successes. Payment state, ownership, money, addresses, products and course lengths are not inferred or changed by these editors.
- Existing own-record Realtime subscriptions stage an update notice. They do not auto-resort, refetch the list or move rows while someone is working. Explicit Refresh applies changes. Team views require manual refresh for changes outside the current user's filtered subscription.

## File map

| File | Change |
|---|---|
| `src/components/grid/DataGrid.tsx` | Generic, fetch-free virtual grid, focus, range selection, columns, skeletons and pagination. |
| `src/components/grid/RecordEditor.tsx` | Optimistic editor, retained draft, rollback and retry/reload. |
| `src/components/grid/RecordPanel.tsx` | On-demand record fields and order product lines. |
| `src/components/ModuleGrid.tsx` | Actual module columns, tabs, saved filters and query/editor composition. |
| `src/components/CrmProvider.tsx` | Session-scoped query cache, viewer context and notifications. |
| `src/components/Shell.tsx` | Reviewed shell, role-filtered navigation, theme, sign-out and command palette. |
| `src/components/Icon.tsx`, `StatusPill.tsx` | Shared icons and business-state presentation. |
| `src/lib/crm/config.ts` | Explicit view fields, module definitions and IST-safe date formatting. |
| `src/lib/crm/queries.ts` | Query hooks for narrow lists, counts, record details and lookup values. |
| `src/lib/crm/actions.ts` | Authenticated, role-checked, version-checked edits using the existing server client. |
| `src/lib/crm/use-live-updates.ts` | Filtered own-record change notifications. |
| `src/types/crm.ts` | Typed view rows, details and edit contracts. |
| `src/app/(app)/*/page.tsx` | Replaces the Today table and three placeholder pages with the integrated grid. |
| `src/app/(app)/layout.tsx` | Supplies authenticated user ID and prevents inactive profiles entering the workspace. |
| `src/app/design-tokens.css`, `crm.css`, `globals.css` | Reviewed tokens and live component styling. |
| `src/app/layout.tsx`, `fonts/` | Bundled Inter font and license. |
| `src/app/login/page.tsx` | Uses accessible primary-button and neutral error tokens. |

## Backend boundaries

No SQL, migrations, imports, customer-file reads or privileged database operations were performed. The two existing Supabase clients, credentials, shared project decisions and applied migrations were not edited. Application reads and writes run under the signed-in user's session.

The backend handoff still needs atomic pool claims, server-authoritative call locks, authorized presence, mandatory-reason cancellation/lost workflows with undo, transactional order creation and operational status transitions. These were simulations in the design prototype and are not presented as working database operations here. Bulk selection currently offers opening the first selected record; bulk writes are not implemented. Today retains the existing database queue and action labels; opening an action reveals the record but does not place calls, book consultations or mark work completed.

The six Orders tabs include Cancelled because that is an existing database state. Unpaid tabs include all non-paid payment states, with the actual state shown in each row. No new database statuses were invented. Date-only fields retain their calendar date, and Done today uses India Standard Time boundaries.

No changes were made to deployment or Tauri packaging. The existing static-export/server-auth mismatch remains outside this UI integration; the verified build target is the existing Next.js web application.

## Verification

See [live-ui-verification.md](./live-ui-verification.md). TypeScript and the normal Next.js production build pass. The 50,000-row test uses synthetic data and bounded DOM rendering, not a 50,000-row database download. Unauthenticated HTTP checks load the sign-in page and redirect protected routes to it.

Authenticated list results, real save/rollback behavior, Realtime publication/delivery and browser screenshots still require a connected, signed-in browser. Browser discovery returned no available browsers during this session. No real customer records were modified as a verification step.
