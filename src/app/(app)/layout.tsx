import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { UserRole } from '@/types/db';
import { Shell } from '@/components/Shell';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  // Role comes from the database, never from the JWT.
  const { data } = await supabase
    .from('users')
    .select('full_name, role, is_active')
    .eq('id', user.id)
    .single();

  if (!data || !data.is_active) return <main style={{ padding: 24 }}>Your account is not active. Contact your administrator.</main>;

  return (
    <Shell name={data.full_name} role={data.role as UserRole} userId={user.id}>
      {children}
    </Shell>
  );
}
