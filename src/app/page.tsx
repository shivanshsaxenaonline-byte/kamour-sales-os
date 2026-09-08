import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { HOME_FOR_ROLE, type UserRole } from '@/types/db';

/**
 * Sends each person to their own starting screen. The role is read from the
 * database rather than the JWT, so a tampered token cannot change the landing
 * page — and RLS would deny the data anyway.
 */
export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data } = await supabase
    .from('users')
    .select('role')
    .eq('id', user.id)
    .single();

  redirect(HOME_FOR_ROLE[(data?.role as UserRole) ?? 'sales_exec']);
}
