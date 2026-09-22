import { cache } from 'react';
import { createClient } from './server';

// Request-local only: layout and page share these reads, never different users.
export const getServerViewer = cache(async () => {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { supabase, user: null, profile: null };
  const { data: profile } = await supabase.from('users')
    .select('full_name,role,is_active').eq('id', user.id).single();
  return { supabase, user, profile };
});
