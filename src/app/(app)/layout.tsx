import { redirect } from 'next/navigation';
import { getServerViewer } from '@/lib/supabase/viewer';
import type { UserRole } from '@/types/db';
import { Shell } from '@/components/Shell';
import { istDateFromTimestamp, istToday } from './rrr/lib/format';
import { loginIdFromEmail } from '@/app/login/accounts';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { supabase, user, profile: data } = await getServerViewer();
  if (!user) redirect('/login');

  if (!data || !data.is_active) return <main style={{ padding: 24 }}>Your account is not active. Contact your administrator.</main>;

  const role = data.role as UserRole;
  let progress: { done: number; left: number } | undefined;
  if (role === 'sales_exec' || role === 'sales_manager') {
    const today = istToday();
    // Both kinds of assigned call count towards the day: a WATI Interested
    // lead is as much of today's work as an AI lead, and a bar that ignored it
    // would read 100% with calls still to make.
    const columns = 'due_on,last_called_at,completed_at';
    const [rrr, wati] = await Promise.all([
      supabase.from('rrr_work_items').select(columns).eq('assigned_to', user.id),
      supabase.from('wati_work_items').select(columns).eq('assigned_to', user.id),
    ]);
    const work = [...(rrr.data ?? []), ...(wati.data ?? [])];
    const calledToday = (value: string | null) =>
      !!value && istDateFromTimestamp(value) === today;
    progress = {
      done: work.filter((item) => calledToday(item.last_called_at)).length,
      left: work.filter((item) =>
        !calledToday(item.last_called_at)
        && item.completed_at === null
        && item.due_on <= today).length,
    };
  }

  return (
    <Shell name={data.full_name} role={role} userId={user.id}
      loginId={loginIdFromEmail(user.email)} progress={progress}>
      {children}
    </Shell>
  );
}
