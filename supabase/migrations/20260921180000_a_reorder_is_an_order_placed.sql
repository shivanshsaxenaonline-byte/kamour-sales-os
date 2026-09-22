-- Any order that happens is an order placed, whether or not a rep called it in.
--
-- Order placed is the number the whole RRR programme is measured on, but until
-- now it only ever got written when a rep logged it during a call. A customer
-- who reorders on their own — website, Zoho, ops re-entering a WhatsApp order,
-- whatever the route — left no trace of that anywhere in the outcome trail.
-- The only place the system even noticed was `hasReordered` on the Medicine
-- Ending screen, and all that does is drop the row from the list; it writes
-- nothing, credits no rep, and closes no task. 320 customers have reordered.
-- Only 55 of them have an order_placed call on record for any of it.
--
-- Two things fix this:
--
--   * Going forward, a trigger on `orders`: when a reorder lands (not the
--     customer's first, not rto/cancelled) and that customer has an open RRR
--     task, the task closes as order_placed — same shape as a rep logging it,
--     minus the note a rep would have written, and credited to whoever was
--     holding the task. A customer with no open task is untouched: nothing
--     was waiting on them, so there is nothing to close.
--   * A one-time backfill of the past: every reorder that has no order_placed
--     claim within the same 21-days-before/7-days-after window the live
--     system already uses to match a rep's call to the order it produced. 626
--     rows, dated to the order, so history counts them where they happened
--     rather than as of today.
--
-- The row this trigger writes carries the same "Automatically marked
-- converted" marker the 004 sheet import used for the same reason — a
-- customer-panel timeline already knows to fold that into the order itself
-- rather than show it as a fabricated call (see isNotACall in
-- customer-panel.tsx) — and it deliberately sits outside
-- fn_order_books_next_call's claim window match, so a silent reorder does not
-- get read as a rep's prediction of one; the customer's next call is Medicine
-- Ending's business once this course is the one they are on.
--
-- Down: supabase/migrations/20260921180000_a_reorder_is_an_order_placed.down.sql

create or replace function public.fn_reorder_closes_open_task() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_work public.rrr_work_items%rowtype;
  v_mark constant text := 'Automatically marked converted: reorder detected, no rep call logged.';
begin
  -- No medicine in hand is not a sale (18 Sep) — nothing to credit.
  if new.stage in ('rto', 'cancelled') then return null; end if;
  -- A re-sync of an old sheet row must not raise closes out of history; the
  -- backfill below is what history gets.
  if new.created_at < now() - interval '120 days' then return null; end if;
  -- Only a reorder — the customer's first order is not a conversion of
  -- anything, it is the thing being converted.
  if not exists (
    select 1 from public.orders o
     where o.customer_id = new.customer_id and o.id <> new.id
       and o.created_at < new.created_at and o.stage not in ('rto', 'cancelled')
  ) then return null; end if;

  select * into v_work from public.rrr_work_items w
   where w.customer_id = new.customer_id and w.completed_at is null
   for update;
  -- Nothing was waiting on this customer, so there is nothing to close. This
  -- is the one thing that keeps this from writing a conversion nobody was
  -- tracking; a customer never assigned an RRR task is not this trigger's
  -- business.
  if v_work.id is null then return null; end if;

  update public.rrr_work_items set
    last_outcome = 'order_placed',
    last_called_at = now(),
    completed_at = now(),
    updated_at = now()
  where id = v_work.id;

  -- Whatever else is open on this customer is answered by the same order —
  -- see 20260921163000, the same reasoning applies here: one event closes
  -- every open repeat-order follow-up, not just the one it happens to match.
  update public.followups set
    outcome = 'order_placed',
    completed_at = now(),
    remark = concat_ws(' | ', remark, v_mark)
  where customer_id = new.customer_id and kind = 'order' and completed_at is null;

  -- The task had no followups row to close (rare, but the two are not the
  -- same table) — write one so the conversion has a record at all.
  if not found then
    insert into public.followups
      (customer_id, kind, order_id, due_at, owner_id, outcome, remark, completed_at, attempt_no)
    values (new.customer_id, 'order', coalesce(v_work.order_id, new.id), now(),
      v_work.assigned_to, 'order_placed', v_mark, now(),
      coalesce((select max(f.attempt_no) from public.followups f
                 where f.customer_id = new.customer_id and f.kind = 'order'), 0) + 1);
  end if;

  return null;
end;
$$;
revoke all on function public.fn_reorder_closes_open_task() from public, anon, authenticated;

drop trigger if exists trg_orders_reorder_closes_task on public.orders;
create trigger trg_orders_reorder_closes_task
  after insert on public.orders
  for each row execute function public.fn_reorder_closes_open_task();

-- The backfill: every reorder with no order_placed claim in the same window
-- the live system uses to match a call to the order it produced. Ranked per
-- customer so several un-logged reorders on one customer file in order
-- without colliding on attempt_no.
with ranked as (
  select o.*, row_number() over (partition by o.customer_id order by o.created_at) as rn
  from public.orders o
  where o.stage not in ('rto', 'cancelled')
),
target as (
  select r.* from ranked r
  where r.rn > 1
    and not exists (select 1 from public.followups f
                      where f.order_id = r.id and f.outcome = 'order_placed')
    and not exists (select 1 from public.followups f
                      where f.customer_id = r.customer_id and f.outcome = 'order_placed'
                        and f.completed_at between r.created_at - interval '21 days'
                                              and r.created_at + interval '7 days')
    and not exists (select 1 from public.wati_work_calls k
                      join public.wati_work_items w on w.id = k.work_id
                     where w.customer_id = r.customer_id and k.outcome = 'order_placed'
                       and k.called_at between r.created_at - interval '21 days'
                                           and r.created_at + interval '7 days')
),
based as (
  select t.*,
    coalesce((select max(f.attempt_no) from public.followups f
               where f.customer_id = t.customer_id and f.kind = 'order'), 0) as base_attempt,
    row_number() over (partition by t.customer_id order by t.created_at) as seq
  from target t
)
insert into public.followups
  (customer_id, kind, order_id, due_at, owner_id, outcome, remark, completed_at, attempt_no,
   created_at, updated_at)
select customer_id, 'order', id, created_at, coalesce(current_owner_id, original_owner_id),
  'order_placed',
  'Automatically marked converted: backfilled 21 Sep 2026 — this order was a reorder with no order_placed logged.',
  created_at, base_attempt + seq, created_at, created_at
from based;
