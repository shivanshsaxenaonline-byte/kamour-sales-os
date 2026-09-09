import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { RrrTable, type RrrRow, type AiLeadRow, type AiRun, type Rep } from './rrr-table';
import type { ContactNumber } from './log-call-dialog';

const CAN_ASSIGN = ['admin', 'ceo', 'coo', 'sales_manager', 'auditor'];

// Shared by both RRR routes. The two lists are two URLs rather than one screen
// with a toggle, because the sidebar has to be able to LINK to each of them —
// and because a route only has to load its own list instead of both.
// One literal, not a concatenation: supabase-js infers the row type from the
// select string, and a built-up string erases that back to a generic error type.
const COLUMNS = 'customer_id, full_name, phone_e164, lifetime_orders, lifetime_value, aov, is_repeat_buyer, last_order_on, days_since_order, payment_profile, current_owner_id, owner_name, is_dnd, attempts, last_contacted_on, last_outcome, next_due_on, open_followup_id, last_order_id, last_order_source';

/** Today on the sales floor, which is not today in UTC after 18:30. Mirrors
 *  the database's own ist_today(); both must agree or the screen asks for a
 *  list under a date the generator never wrote. */
function istToday() {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

export async function RrrScreen({ mode }: { mode: 'all' | 'ai' }) {
  const supabase = await createClient();

  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login');

  const { data: me } = await supabase
    .from('users').select('role').eq('id', user.id).single();
  const role = me?.role ?? '';

  const today = istToday();

  // Both counts always, because both tabs always show one. head:true asks for
  // the count and no rows, so the list you are NOT looking at costs nothing.
  const [allCount, aiCount] = await Promise.all([
    supabase.from('v_rrr_queue').select('customer_id', { count: 'exact', head: true }),
    supabase.from('v_rrr_ai_leads').select('customer_id', { count: 'exact', head: true })
      .eq('run_on', today),
  ]);

  const rows: RrrRow[] = [];
  let aiLeads: AiLeadRow[] = [];
  let error: { message: string } | null = null;

  if (mode === 'all') {
    // The whole base, not a slice: this screen exists to look across everyone
    // and decide, so a cap would quietly hide customers from the person whose
    // job is to see them all. PostgREST returns at most 1,000 rows per
    // request, so it is read in pages and stitched. ~1,300 rows today; the
    // loop has a hard ceiling so a future data explosion degrades instead of
    // hanging.
    const PAGE = 1000;
    const MAX_PAGES = 20;
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
  } else {
    // Never more than the team's total daily cap (45 today), so it is one
    // small request and needs no paging. A sales exec gets back only the
    // fifteen dealt to them — RLS, not a filter here.
    const { data, error: aiError } = await supabase
      .from('v_rrr_ai_leads')
      .select(`run_on, rank, bucket, bucket_label, priority_score, reason, ai_owner_id, ai_owner_name, ${COLUMNS}`)
      .eq('run_on', today)
      .order('rank');
    if (aiError) error = aiError;
    else aiLeads = (data ?? []) as AiLeadRow[];
  }

  const [aiRun, numbers, reps] = await Promise.all([
    supabase.from('ai_lead_runs').select('run_on, generated_at, total')
      .eq('run_on', today).maybeSingle(),
    supabase.from('contact_numbers').select('id, label_en')
      .eq('is_active', true).order('sort_order'),
    supabase.from('users').select('id, full_name, role')
      .in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
  ]);

  if (error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>RRR</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load the {mode === 'ai' ? 'AI lead list' : 'RRR list'}.</p>
          <p className="muted">{error.message}</p>
        </div>
      </section>
    );
  }

  return (
    <RrrTable
      mode={mode}
      rows={rows}
      aiLeads={aiLeads}
      counts={{ all: allCount.count ?? 0, ai: aiCount.count ?? 0 }}
      aiRun={(aiRun.data ?? null) as AiRun | null}
      reps={(reps.data ?? []) as Rep[]}
      canAssign={CAN_ASSIGN.includes(role)}
      numbers={(numbers.data ?? []) as ContactNumber[]}
    />
  );
}
