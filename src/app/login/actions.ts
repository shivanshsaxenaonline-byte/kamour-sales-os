'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LOGIN_IDS } from './accounts';

export async function selectAccount(_previous: string, form: FormData): Promise<string> {
  if (process.env.KAMOUR_ID_PICKER !== '1') {
    return 'Account selection is not enabled.';
  }
  const id = form.get('account');
  if (typeof id !== 'string' || !LOGIN_IDS.some(account => account === id)) {
    return 'Choose one of the listed IDs.';
  }
  const password = process.env.SEED_TEMP_PASSWORD;
  if (!password) return 'Account access is not configured.';

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: `${id}@kamour.local`, password,
  });
  if (error || !data.user) return 'Could not sign in to this ID. Please try again.';

  const { data: profile, error: profileError } = await supabase
    .from('users').select('is_active').eq('id', data.user.id).single();
  if (profileError || !profile?.is_active) {
    await supabase.auth.signOut();
    return 'This ID is unavailable. Choose another ID.';
  }
  redirect('/');
}
