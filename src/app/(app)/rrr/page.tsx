import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RrrTable, type RrrRow, type AiLeadRow, type AiRun, type Rep } from './rrr-table';
import type { ContactNumber } from './log-call-dialog';

// The list is per-viewer (RLS decides which customers are visible) and changes
// as soon as anyone assigns, so it is never a build-time snapshot.
export const dynamic = 'force-dynamic';

const CAN_ASSIGN = ['admin', 'ceo', 'coo', 'sales_manager', 'auditor'];

/** Today on the sales floor, which is not today in UTC after 18:30. Mirrors
 *  the database's own ist_today(); both must agree or the screen asks for a
 *  list under a date the generator never wrote. */
function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

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

  // Today's AI list. Never more than the team's total daily cap (45 today), so
  // it is one small request and needs no paging. A sales exec gets back only
  // the fifteen dealt to them — RLS, not a filter here.
  const today = istToday();
  const [aiLeads, aiRun, numbers, reps] = await Promise.all([
    supabase
      .from('v_rrr_ai_leads')
      .select(`run_on, rank, bucket, bucket_label, priority_score, reason, ai_owner_id, ai_owner_name, ${COLUMNS}`)
      .eq('run_on', today)
      .order('rank'),
    supabase
      .from('ai_lead_runs')
      .select('run_on, generated_at, total')
      .eq('run_on', today)
      .maybeSingle(),
    supabase
      .from('contact_numbers')
      .select('id, label_en')
      .eq('is_active', true)
      .order('sort_order'),
    supabase
      .from('users')
      .select('id, full_name, role')
      .in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true)
      .order('full_name'),
  ]);

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
      // A failure here must not take down the main list, which is the screen's
      // reason to exist; the AI tab then shows "not generated yet".
      aiLeads={(aiLeads.data ?? []) as AiLeadRow[]}
      aiRun={(aiRun.data ?? null) as AiRun | null}
      reps={(reps.data ?? []) as Rep[]}
      canAssign={CAN_ASSIGN.includes(role)}
      numbers={(numbers.data ?? []) as ContactNumber[]}
    />
  );
}
