# Local account selection

At http://localhost:3000/login, select one of the eight active team IDs. There are no text or password fields. Selection signs in through normal Supabase password authentication on the server, checks the active user profile, and lets existing role routing open the workspace. No service-role client or database-policy bypass is used.

This mode permits anyone using the local app to choose any listed account. It is explicitly enabled only for local preview; the running server is bound to 127.0.0.1. Public deployments retain the existing password form.

For subsequent local starts, set server-only environment variables `KAMOUR_LOCAL_ACCOUNT_PICKER=1` and `SEED_TEMP_PASSWORD` to the existing team seed password, then run `npm.cmd run start -- --hostname 127.0.0.1` after building. Never use NEXT_PUBLIC-prefixed variables for the password. This session supplied these variables to the server process without editing .env.local. If team passwords change, update local credentials; the picker does not reset accounts.

Implementation: login/page.tsx selects the local picker or existing password form; account-picker.tsx renders the ID buttons and pending/error states; accounts.ts allowlists the eight existing login IDs; actions.ts checks local mode, host, account ID and active profile before redirecting. Next.js Server Actions enforce same-origin form submission.

Verification: production build including TypeScript passed. HTTP checks confirmed eight ID buttons and no password input. Multipart form submissions for all eight accounts established real sessions, redirected to the expected role home, and opened that protected page with HTTP 200. Unknown IDs and cross-origin requests were rejected without sessions. Checks did not modify customer records. Browser discovery returned no available browser, so visual interaction was not inspected in a browser.
