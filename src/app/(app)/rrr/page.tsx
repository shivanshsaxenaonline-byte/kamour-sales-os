import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RrrTable, type RrrRow, type Rep } from './rrr-table';
import type { ContactNumber } from './log-call-dialog';

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

  // The whole base, not a slice: this screen exists to look across everyone
  // and decide, so a cap would quietly hide customers from the person whose
  // job is to see them all. PostgREST returns at most 1,000 rows per request,
  // so it is read in pages and stitched. ~1,300 rows today; the loop has a
  // hard ceiling so a future data explosion degrades instead of hanging.
  const COLUMNS = 'customer_id, full_name, phone_e164, lifetime_orders, lifetime_value, aov, is_repeat_buyer, last_order_on, days_since_order, payment_profile, current_owner_id, owner_name, is_dnd, attempts, last_contacted_on, last_outcome, next_due_on, open_followup_id, last_order_id, last_order_source';
  const PAGE = 1000;
  const MAX_PAGES = 20;

  const rows: RrrRow[] = [];
  let error: { message: string } | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error: pageError } = await supabase
      .from('v_rrr_queue')
      .select(COLUMNS)
      // Unassigned first — that is the work this screen hands out — then by
      // what the customer is worth. customer_id breaks ties so paging is
      // stable; without it two rows with equal value can swap between pages
      // and one gets fetched twice while another is never fetched at all.
      .order('current_owner_id', { ascending: true, nullsFirst: true })
      .order('lifetime_value', { ascending: false })
      .order('customer_id', { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);

    if (pageError) { error = pageError; break; }
    rows.push(...((data ?? []) as RrrRow[]));
    if (!data || data.length < PAGE) break;
  }

  const { data: numbers } = await supabase
    .from('contact_numbers')
    .select('id, label_en')
    .eq('is_active', true)
    .order('sort_order');

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
      rows={rows}
      reps={(reps ?? []) as Rep[]}
      canAssign={CAN_ASSIGN.includes(role)}
      numbers={(numbers ?? []) as ContactNumber[]}
    />
  );
}
