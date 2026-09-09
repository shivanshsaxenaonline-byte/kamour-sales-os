'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';

/**
 * Rebuild today's AI lead list on demand.
 *
 * The list is produced by a cron job at 04:30 IST every morning, so this is
 * the exception, not the normal path: the team has just changed the mix, or
 * added a rep, or somebody was called from a different screen and the list
 * should reflect it. `p_force` is what makes it a rebuild rather than the
 * usual no-op — `fn_generate_ai_daily_leads` deliberately refuses to reshuffle
 * a day that already has a list, because a rep's fifteen must not change
 * underneath them mid-morning.
 *
 * Permission is decided in the database, not here. The button is hidden from
 * roles that cannot generate; the function is what actually enforces it.
 */
export async function refreshAiLeads(): Promise<
  { ok: true; total: number } | { ok: false; error: string }
> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('fn_generate_ai_daily_leads', {
    p_run_on: null,
    p_force: true,
  });

  if (error) return { ok: false, error: error.message };

  revalidatePath('/rrr');
  return { ok: true, total: data ?? 0 };
}
