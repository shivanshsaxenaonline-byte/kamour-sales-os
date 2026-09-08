# Integrated UI verification

DOM/event checks against the actual React grid, using synthetic records. Happy DOM does not prove real-browser geometry.

The ten assertions below completed successfully. The standalone DOM harness retained background handles after reporting and was stopped manually; this is not reported as a clean test-runner exit.

- PASS: 50,000-row input creates only a bounded virtual DOM
- PASS: J/K navigation and E identify the correct row
- PASS: Space selects and Escape clears without moving rows
- PASS: Shift-click selects a contiguous row range
- PASS: Enter expands the focused record and Escape closes it
- PASS: Search shortcut focuses a labelled search input
- PASS: Column visibility is persisted per user key
- PASS: Server sort and pagination callbacks are invoked
- PASS: Loading preserves the header and creates twenty skeleton rows
- PASS: Postgres dates remain unchanged and Done today uses IST boundaries

## Application checks

- `npm.cmd run typecheck`: passed with strict TypeScript settings unchanged.
- `npm.cmd run build`: passed; all four module routes compiled (212 kB first-load JavaScript each).
- Login: HTTP 200 and the expected username/password form.
- Unauthenticated Leads request: redirected to `/login`.
- Static scan of new UI/data files: no wildcard selection, service-role credentials, raw payload reads, polling intervals or explicit `any`.
- Authenticated database results, actual save behavior and Realtime delivery: not verified; awaiting the user's normal sign-in.
- Browser screenshots, native focus behavior and measured 1366 × 768 row geometry: not verified; browser discovery returned no available browsers.
