'use client';

import { createBrowserClient } from '@supabase/ssr';

/**
 * Browser client. Uses the anon key, which ships in the bundle and is therefore
 * public — every table is protected by RLS, and an anon request without a
 * session returns 401 on everything. Verified against the live API (D-037).
 */
export function createClient() {
  return createBrowserClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  );
}
