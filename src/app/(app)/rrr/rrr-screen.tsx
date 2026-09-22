import { redirect } from 'next/navigation';
import { getServerViewer } from '@/lib/supabase/viewer';
import { RrrTable, type RrrRow, type AiLeadRow, type AiRun, type Rep, type WorkAssignment } from './rrr-table';
import type { ContactNumber } from './log-call-dialog';
import { istToday } from './lib/format';
import { PAGE_SIZE, parseFilters, parsePage, type QueryParams } from './lib/filters';
import { AI_COLUMNS, fetchRrrPage } from './lib/query';

const CAN_ASSIGN = ['admin', 'ceo', 'coo', 'auditor'];

// Shared by both RRR routes. The two lists are two URLs rather than one screen
// with a toggle, because the sidebar has to be able to LINK to each of them —
// and because a route only has to load its own list instead of both.

export async function RrrScreen({ mode, params }: { mode: 'all' | 'ai'; params: QueryParams }) {
  const { supabase, user, profile: me } = await getServerViewer();
  if (!user) redirect('/login');
  if (me?.role === 'sales_exec' || me?.role === 'sales_manager') redirect('/rrr/my');

  const filters = parseFilters(params);
  const page = parsePage(params);
  // Read once and passed down, so a request cannot straddle midnight IST
  // between its count query and its rows query and answer from two days.
  const today = istToday();

  // Everything this screen needs, in one wave.
  //
  // It used to be three: the list, then the two tab counts, then the run/
  // numbers/reps batch — each waiting on the one before for no reason, since
  // none of them feed each other. Now the only thing that is awaited first is
  // the session, because RLS needs it.
  const isAi = mode === 'ai';

  // The list itself. On the All tab this is one bounded range query carrying
  // its own exact count — fifty rows, not thirteen hundred. On the AI tab it is
  // the whole day, which is never more than the team's total daily cap (45
  // today), so it needs no paging; a sales exec gets back only the fifteen
  // dealt to them, by RLS rather than by a filter here.
  //
  // Two slots rather than one conditional slot: the results have different
  // shapes, and a union of them would have to be cast apart again downstream.
  const queuePromise = isAi ? null : fetchRrrPage(supabase, filters, today, page);
  const aiPromise = isAi
    ? supabase.from('v_rrr_ai_leads').select(AI_COLUMNS).eq('run_on', today).order('rank')
    : null;

  const [allCount, aiCount, queue, ai, aiRun, numbers, usualNumber, reps, work] = await Promise.all([
    // Both counts always, because both tabs always show one. head:true asks for
    // the count and no rows, so the list you are NOT looking at costs nothing.
    supabase.from('v_rrr_queue').select('customer_id', { count: 'exact', head: true }),
    supabase.from('v_rrr_ai_leads').select('customer_id', { count: 'exact', head: true })
      .eq('run_on', today),

    queuePromise,
    aiPromise,

    supabase.from('ai_lead_runs').select('run_on, generated_at, total')
      .eq('run_on', today).maybeSingle(),
    supabase.from('contact_numbers').select('id, label_en')
      .eq('is_active', true).order('sort_order'),
    // See fn_my_calling_number: the number this viewer last dialled.
    supabase.rpc('fn_my_calling_number'),
    supabase.from('users').select('id, full_name, role')
      .in('role', ['sales_exec', 'sales_manager'])
      .eq('is_active', true).order('full_name'),
    isAi ? supabase.from('rrr_work_items')
      .select('customer_id, source, assigned_to, assigned_at, due_on, last_outcome, medicine_days_left, completed_at')
      .eq('source', 'ai').eq('source_date', today)
      .order('updated_at', { ascending: false }).limit(500)
      : Promise.resolve({ data: [] }),
  ]);

  const role = me?.role ?? '';

  const rows = (queue?.rows ?? []) as RrrRow[];
  const aiLeads = (ai?.data ?? []) as unknown as AiLeadRow[];

  // Who is holding the call, on the All list too. The AI tab asks for the whole
  // day up front; here the page is fifty rows, so the open tasks behind exactly
  // those fifty are one small follow-up query rather than a second full table.
  // Without it the All tab is the one RRR screen that cannot show that a lead
  // has already been handed over.
  let work_items = (work.data ?? []) as WorkAssignment[];
  if (!isAi && rows.length) {
    const { data: open } = await supabase.from('rrr_work_items')
      .select('customer_id, source, assigned_to, assigned_at, due_on, last_outcome, medicine_days_left, completed_at')
      .in('customer_id', rows.map((r) => r.customer_id))
      .is('completed_at', null);
    work_items = (open ?? []) as WorkAssignment[];
  }

  // What was in each lead's last order and when that course runs out. The date
  // is the view's — the same column the generator's window is built on — so the
  // screen and the list that produced it cannot disagree. Capped at the day's
  // total (45), so this is one small query.
  const lastOrderIds = aiLeads.map((a) => a.last_order_id).filter((id): id is string => !!id);
  if (lastOrderIds.length) {
    const { data: lastOrders } = await supabase.from('v_rrr_customer_orders')
      .select('order_id, products, medicine_ends_on, medicine_ends_estimated').in('order_id', lastOrderIds);
    const byId = new Map((lastOrders ?? []).map((o) => [o.order_id as string, o]));
    for (const a of aiLeads) {
      const o = a.last_order_id ? byId.get(a.last_order_id) : undefined;
      a.last_order_products = o?.products ?? null;
      a.medicine_ends_on = o?.medicine_ends_on ?? null;
      a.medicine_ends_estimated = !!o?.medicine_ends_estimated;
    }
  }
  // On the All tab the database counted the filter for us. On the AI tab the
  // whole day is in hand, so the match count is however many the client-side
  // controls keep — the table works that out and tells the footer.
  const matched = isAi ? aiLeads.length : (queue?.count ?? 0);
  const error = queue?.error ?? ai?.error ?? null;

  if (error) {
    return (
      <section className="data-grid">
        <div className="grid-toolbar"><h1>RRR</h1></div>
        <div className="grid-empty" role="alert">
          <p>Could not load the {isAi ? 'AI lead list' : 'RRR list'}.</p>
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
      filters={filters}
      page={page}
      pageSize={PAGE_SIZE}
      matched={matched}
      counts={{ all: allCount.count ?? 0, ai: aiCount.count ?? 0 }}
      aiRun={(aiRun.data ?? null) as AiRun | null}
      reps={(reps.data ?? []) as Rep[]}
      workAssignments={work_items}
      canAssign={CAN_ASSIGN.includes(role)}
      canLog={role !== 'auditor'}
      numbers={(numbers.data ?? []) as ContactNumber[]}
      preferredNumberId={(usualNumber.data as string | null) ?? null}
      today={today}
    />
  );
}
