# ID-picker login

At `/login`, select one of the eight active team IDs. There are no text or password fields. Selection signs in through normal Supabase password authentication on the server, checks the active user profile, and lets existing role routing open the workspace. No service-role client or database-policy bypass is used.

**Update (D-061):** this is now enabled on the live Vercel deployment, not only local preview, per explicit user request ("basic login page with all ids"). This means anyone who reaches the deployed URL can sign in as any of the eight listed team members with a single click — the picker itself asks for no password from the visitor. The team's shared password is only ever read server-side from `SEED_TEMP_PASSWORD`; it is never sent to the browser. This is an accepted tradeoff for a small internal team, not a general-purpose login. If the Vercel URL is ever shared outside the team, or the app grows past this trusted-team assumption, replace this with per-person passwords or another gate.

To enable in any environment (local or Vercel), set the server-only environment variables `KAMOUR_ID_PICKER=1` and `SEED_TEMP_PASSWORD` (the existing team seed password). Never use NEXT_PUBLIC-prefixed variables for the password. If team passwords change, update this value; the picker does not reset accounts.

Implementation: login/page.tsx selects the local picker or existing password form; account-picker.tsx renders the ID buttons and pending/error states; accounts.ts allowlists the eight existing login IDs; actions.ts checks local mode, host, account ID and active profile before redirecting. Next.js Server Actions enforce same-origin form submission.

Verification: production build including TypeScript passed. HTTP checks confirmed eight ID buttons and no password input. Multipart form submissions for all eight accounts established real sessions, redirected to the expected role home, and opened that protected page with HTTP 200. Unknown IDs and cross-origin requests were rejected without sessions. Checks did not modify customer records. Browser discovery returned no available browser, so visual interaction was not inspected in a browser.
