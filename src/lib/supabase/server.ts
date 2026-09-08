import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

/**
 * Server client for Server Components and Route Handlers.
 * Never uses the service-role key: that key bypasses RLS entirely and must stay
 * out of anything that renders for a user.
 */
export async function createClient() {
  const store = await cookies();

  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            for (const { name, value, options } of list) store.set(name, value, options);
          } catch {
            // Called from a Server Component — middleware refreshes the session
            // instead, so this is safe to ignore.
          }
        },
      },
    },
  );
}
