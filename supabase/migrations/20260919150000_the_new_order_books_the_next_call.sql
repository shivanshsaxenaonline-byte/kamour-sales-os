-- The order the rep said was coming books the next call by itself.
--
-- "Order placed" closes the task and books nothing, because the next call
-- belongs to the course the customer has just bought — and on the day of the
-- call nobody knows what that course is. The Medicine Order sheet knows a day
-- or two later: duration, and the delivery date when the courier reports one.
-- So the order schedules the call, not the rep.
--
-- The date, and why:
--
--   * delivered date + course days, when the sheet has a delivery date. This
--     is exactly what the Medicine Ending screen computes, so the two cannot
--     disagree about when a course runs out.
--   * order date + 6 + course days when it does not, which is the common case:
--     only 148 of the 583 orders in the last six months are ever marked
--     delivered, the rest sit at `confirmed` forever. Six days is measured,
--     not guessed — the median order-to-delivery gap across the 147 deliveries
--     on record (p90 is 11). Waiting for a delivery date that never comes
--     would mean three out of four orders never book their call.
--   * minus 3 days, because the call has to happen *before* the medicine runs
--     out, and the floor's own rule from 19 Sep is two to three days ahead.
--   * never earlier than tomorrow. A course that already ran out while the
--     sheet caught up is due now, not in the past.
--   * course days from the order; failing that, the longest course among its
--     own products; failing that 15, which is 456 of the 515 recent orders
--     that state one.
--
-- When the delivery date arrives later, the same trigger moves the call it
-- already booked. When the parcel comes back (`rto`) or the order is
-- cancelled, it takes the booked call away again — a customer with no medicine
-- in hand is not on a course, and the rule that a returned parcel is not a
-- sale (18 Sep) applies to the call it would have earned.
--
-- Only orders a rep claimed are scheduled here: an `order_placed` call on that
-- customer — a real call, not one of the 184 rows the old sheet import wrote
-- about an order that already existed — within 21 days before the order date
-- and 7 days after it. Every
-- other order is the Medicine Ending screen's business, which reads delivered
-- orders directly and would otherwise be duplicated for the whole base. The
-- rep who made the claim owns the follow-up, so Action due shows whose order
-- it was.
--
-- Down: supabase/migrations/20260919150000_the_new_order_books_the_next_call.down.sql

-- The date rule, on its own so the trigger and any report agree about it.
create or replace function public.fn_course_call_on(
  p_delivered timestamptz, p_ordered timestamptz, p_course_days integer
) returns date
language sql immutable set search_path = public as $$
  select (coalesce(
      (p_delivered at time zone 'Asia/Kolkata')::date,
      (p_ordered at time zone 'Asia/Kolkata')::date + 6   -- measured transit
    ) + coalesce(p_course_days, 15)) - 3                  -- call before it ends
$$;
comment on function public.fn_course_call_on(timestamptz, timestamptz, integer) is
  'When to ring a customer about the course this order carries: delivery date (or order date + the 6-day median transit) + course length, three days early.';

-- The course this order actually carries.
create or replace function public.fn_order_course_days(p_order uuid, p_stated integer)
returns integer
language sql stable set search_path = public as $$
  select coalesce(
    p_stated,
    (select max(pr.default_course_days) from order_items oi
       join products pr on pr.id = oi.product_id
      where oi.order_id = p_order),
    15)
$$;

-- `orders.next_followup_at` says the same thing on the order itself.
--
-- The column has been there since 004 as `(dispatch_date + course_duration_days) - 4`,
-- and it has never once held a value: nothing writes `dispatch_date` — the
-- sheet has no such cell — so all 2,037 orders carry null in a column whose
-- name promises the answer. It is generated, so a trigger cannot write it
-- either; assignments in a BEFORE trigger are silently discarded. The
-- expression is what has to change.
--
-- Same rule as the follow-up, from the same function, so the order and the
-- call it books can never disagree. A returned or cancelled parcel carries no
-- date, because there is no course to end. (A stored generated column is not
-- recomputed when the function changes; anything that alters `fn_course_call_on`
-- has to rewrite the column too, which is why the rule lives in one place.)
drop view if exists public.v_orders_list;
alter table public.orders drop column next_followup_at;
alter table public.orders add column next_followup_at date
  generated always as (
    case when stage in ('rto', 'cancelled') then null
         else public.fn_course_call_on(delivered_at, created_at, course_duration_days)
    end) stored;
comment on column public.orders.next_followup_at is
  'When this order''s course runs out, three days early: delivery date (or order date + the 6-day median transit) + course length. Null once the parcel is returned or cancelled.';

-- Recreated unchanged but for the column above, with the security_invoker and
-- grants it had — the CRM orders module reads this view.
create view public.v_orders_list with (security_invoker = true) as
 SELECT o.id, o.order_no, o.customer_id, c.full_name, c.phone_e164 AS phone,
    o.amount, o.discount, o.stage, o.payment_state, pm.label_en AS payment_mode,
    cu.label_en AS courier, o.awb, o.dispatch_date, o.course_duration_days,
    o.next_followup_at, o.is_repeat, o.current_owner_id, u.full_name AS owner_name,
    o.created_at, o.shipping_amount, o.delivered_at, ls.label_en AS source,
    o.order_notes, o.ad_code, o.gclid, o.sheet_row_number
   FROM orders o
     JOIN customers c ON c.id = o.customer_id
     LEFT JOIN payment_modes pm ON pm.id = o.payment_mode_id
     LEFT JOIN couriers cu ON cu.id = o.courier_id
     LEFT JOIN lead_sources ls ON ls.id = o.source_id
     LEFT JOIN users u ON u.id = o.current_owner_id
  WHERE c.merged_into_id IS NULL;
grant all on public.v_orders_list to authenticated, service_role;
-- Default privileges hand a new object to anon as well; this view never was
-- anon's to read, and RLS on the tables under it is not a reason to skip this.
revoke all on public.v_orders_list from anon;

create or replace function public.fn_order_books_next_call() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_mark    constant text := 'Course follow-up scheduled from the order';
  v_claim   record;
  v_open    record;
  v_due     date;
  v_attempt integer;
begin
  -- No medicine in hand: whatever was booked for this order is not a course
  -- call any more.
  if new.stage in ('rto', 'cancelled') then
    delete from public.followups f
      where f.order_id = new.id and f.completed_at is null and f.remark = v_mark;
    return null;
  end if;
  -- A re-sync of an old sheet row must not raise calls out of history.
  if new.created_at < now() - interval '120 days' then return null; end if;
  if exists (select 1 from public.customers c where c.id = new.customer_id
             and (c.is_dnd or c.merged_into_id is not null)) then
    return null;
  end if;

  -- The claim this order answers, from either list a call can be logged in.
  select owner_id, at into v_claim from (
    select f.owner_id, f.completed_at as at
      from public.followups f
     where f.customer_id = new.customer_id and f.outcome = 'order_placed'
       and f.completed_at is not null
       -- Rows the old sheet import wrote *because* an order already existed
       -- are not a rep saying one is coming. They are bookkeeping, and the
       -- customer timeline hides them as not-a-call for the same reason.
       and coalesce(f.remark, '') !~* 'Automatically marked converted|Course follow-up scheduled'
       and f.completed_at between new.created_at - interval '21 days'
                              and new.created_at + interval '7 days'
    union all
    select k.owner_id, k.called_at
      from public.wati_work_calls k
      join public.wati_work_items w on w.id = k.work_id
     where w.customer_id = new.customer_id and k.outcome = 'order_placed'
       and k.called_at between new.created_at - interval '21 days'
                           and new.created_at + interval '7 days'
  ) claims order by at desc limit 1;
  if v_claim.at is null then return null; end if;

  v_due := greatest(
    public.fn_course_call_on(new.delivered_at, new.created_at,
      public.fn_order_course_days(new.id, new.course_duration_days)),
    public.ist_today() + 1);

  -- At most one open follow-up per customer — every RRR screen reads the
  -- earliest open row as the customer's current task. If something else is
  -- already waiting on them, that call comes first and this one would stack
  -- behind it; only the row this trigger booked is ours to move.
  select f.id, f.remark, f.order_id into v_open
    from public.followups f
   where f.customer_id = new.customer_id and f.completed_at is null
   order by f.due_at limit 1;

  if v_open.id is not null then
    if v_open.remark = v_mark and v_open.order_id = new.id then
      update public.followups
         set due_at = v_due::timestamp at time zone 'Asia/Kolkata',
             owner_id = coalesce(v_claim.owner_id, owner_id),
             updated_at = now()
       where id = v_open.id;
    end if;
    return null;
  end if;

  select coalesce(max(f.attempt_no), 0) + 1 into v_attempt
    from public.followups f
   where f.customer_id = new.customer_id and f.kind = 'order';
  insert into public.followups
    (customer_id, kind, order_id, due_at, owner_id, attempt_no, remark)
  values (new.customer_id, 'order', new.id,
    v_due::timestamp at time zone 'Asia/Kolkata', v_claim.owner_id,
    coalesce(v_attempt, 1), v_mark);
  return null;
end;
$$;
revoke all on function public.fn_order_books_next_call() from public, anon, authenticated;

drop trigger if exists trg_orders_book_next_call on public.orders;
create trigger trg_orders_book_next_call
  after insert or update of delivered_at, course_duration_days, stage on public.orders
  for each row execute function public.fn_order_books_next_call();
