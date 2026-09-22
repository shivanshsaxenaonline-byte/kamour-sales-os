'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { LOGIN_IDS, PASSWORD_REQUIRED_IDS, RRR_ONLY_IDS } from './accounts';
import { HOME_FOR_ROLE, type UserRole } from '@/types/db';

export async function selectAccount(_previous: string, form: FormData): Promise<string> {
  if (process.env.KAMOUR_ID_PICKER !== '1') {
    return 'Account selection is not enabled.';
  }
  const id = form.get('account');
  if (typeof id !== 'string' || !LOGIN_IDS.some(account => account === id)) {
    return 'Choose one of the listed IDs.';
  }
  const passwordRequired = PASSWORD_REQUIRED_IDS.includes(id as (typeof LOGIN_IDS)[number]);
  const password = passwordRequired
    ? form.get('password')
    : process.env.SEED_TEMP_PASSWORD;
  if (typeof password !== 'string' || !password) {
    return passwordRequired
      ? 'Enter the password for this ID.'
      : 'Account access is not configured.';
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithPassword({
    email: `${id}@kamour.local`, password,
  });
  if (error || !data.user) {
    // The rep only sees a generic message; the reason (wrong password, rate
    // limit, network) belongs in the server log where it can be diagnosed.
    console.error('ID sign-in failed', { id, status: error?.status, code: error?.code, message: error?.message });
    return error?.status === 429
      ? 'Too many sign-in attempts. Please wait a minute and try again.'
      : passwordRequired
        ? 'Wrong password. Please try again.'
        : 'Could not sign in to this ID. Please try again.';
  }

  const { data: profile, error: profileError } = await supabase
    .from('users').select('is_active,role').eq('id', data.user.id).single();
  if (profileError || !profile?.is_active) {
    await supabase.auth.signOut();
    return 'This ID is unavailable. Choose another ID.';
  }
  // Land directly in the user's section, avoiding two extra authenticated requests.
  redirect(RRR_ONLY_IDS.includes(id as (typeof LOGIN_IDS)[number])
    ? '/rrr'
    : HOME_FOR_ROLE[profile.role as UserRole]);
}
