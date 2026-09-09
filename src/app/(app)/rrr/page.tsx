import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RrrTable, type RrrRow, type Rep } from './rrr-table';

// The list is per-viewer (RLS decides which customers are visible) and changes
// as soon as anyone assigns, so it is never a build-time snapshot.
export const dynamic = 'force-dynamic';

const CAN_ASSIGN = ['admin', 'ceo', 'coo', 'sales_manager', 'auditor'];

export default async function RrrPage() {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('users').select('role').eq('id', user.id).single();
  const role = me?.role ?? '';

  // Ordering: unassigned first (that is the work this screen exists to hand
  // out), then by what the customer is worth. Capped — the whole base is
  // 1,300 rows today but this screen must not become a full-table scroll if
  // that grows; filtering is the next thing to build here if it does.
  const { data: rows, error } = await supabase
    .from('v_rrr_queue')
    .select('customer_id, full_name, phone_e164, rfm_segment, lifetime_orders, lifetime_value, last_order_on, days_since_order, current_owner_id, owner_name, attempts, last_contacted_on, last_outcome, next_due_on, last_order_source, is_dnd')
    .order('current_owner_id', { ascending: true, nullsFirst: true })
    .order('lifetime_value', { ascending: false })
    .limit(500);

  const { data: reps } = await supabase
    .from('users')
    .select('id, full_name, role')
    .in('role', ['sales_exec', 'sales_manager'])
    .eq('is_active', true)
    .order('full_name');

  if (error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>RRR</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load the RRR list.</p>
          <p className="muted">{error.message}</p>
        </div>
      </section>
    );
  }

  return (
    <RrrTable
      rows={(rows ?? []) as RrrRow[]}
      reps={(reps ?? []) as Rep[]}
      canAssign={CAN_ASSIGN.includes(role)}
    />
  );
}
