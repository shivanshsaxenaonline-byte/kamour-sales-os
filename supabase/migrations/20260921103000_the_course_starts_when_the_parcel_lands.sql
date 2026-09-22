-- The course starts when the parcel lands, not when the order is placed.
--
-- User, on a lead dealt to Tejasv on 20 Sep whose card read "Medicine ends
-- 9 Oct": "why this lead came and assigned to tejasv when its order was ending
-- on 9 oct..?" — and then, on today's rank-3 lead: "if iski medicine 16 oct ko
-- khatam horhi h then why is there a need to take followup, followup to usko
-- hoga jis medicine khatam hogyi h ya medicine ko khatam hone m 3-4 din bache
-- ha."
--
-- Three separate faults, measured on 21 Sep 2026 against this database:
--
-- 1. The refill window counted from the ORDER date. The parcel takes a week to
--    arrive (median 6 days, mean 7.0, over the 130 delivered orders carrying
--    both dates) and nobody takes a tablet they have not received, so every
--    refill call landed about a week early by construction. 6 of the day's 8
--    `refill` leads still had 10 to 25 days of medicine in hand.
--
-- 2. The course length came from orders.course_duration_days alone, with a
--    flat 15-day fallback. 1,122 of 2,043 orders carry no duration, and 232
--    more carry a recorded 15 against a 60N box. The tablets themselves are
--    the better witness — products.default_course_days has said 60N = 30 days
--    and 30N = 15 days since the catalogue was built (004) — and nothing read
--    it. Today's rank-3 lead was called a "15-day course" by the generator and
--    a 30-day course by the screen, over the same order.
--
-- 3. The refill window was only ever one branch of the bucket CASE. `slipping`
--    means nothing more than "ordered within 60 days"; the score-based top-up
--    fills the tail of the day from whoever is left. So the lead above was not
--    a refill lead at all — it was dealt `slipping`, rank 44 of 45, score 21,
--    and its 9 Oct end date was never consulted by anything.
--
-- What changes: the window moves onto the delivery clock, the course length is
-- decided by the tablets, and no bucket but `overdue` and `retry` may deal a
-- customer whose medicine still has more than three days to run. Those two are
-- exempt because a promised callback and an unanswered ring are not questions
-- about medicine.
--
-- Measured effect on 21 Sep 2026: the day still fills 45 of 45, and the number
-- of leads holding more than three days of medicine falls from 11 to 1 — that
-- one being an `overdue` promise the floor made itself. Worth saying plainly:
-- only 28 customers are inside the refill window at all today and only 3 of
-- them have not been rung this week, so an honest refill list is a handful of
-- names a day, not a bucket of twelve.
--
-- Down: supabase/migrations/20260921103000_the_course_starts_when_the_parcel_lands.down.sql

-- ---------------------------------------------------------------------------
-- One definition of when the medicine runs out, for every screen that shows it.
--
-- Before this, three files computed it three ways: the generator from the order
-- date, rrr/lib/format.ts from delivery + 7 with a 30-day fallback, and
-- medicine-ending/page.tsx from delivery + the recorded duration only. The two
-- numbers in a single row of the AI list came from two of them.
-- ---------------------------------------------------------------------------
create or replace view v_rrr_customer_orders with (security_invoker = true) as
select
  o.customer_id,
  o.id                                            as order_id,
  o.order_no,
  (o.created_at at time zone 'Asia/Kolkata')::date as ordered_on,
  o.amount,
  o.discount,
  o.stage,
  o.payment_state,
  pm.label_en                                     as payment_mode,
  o.ship_state,
  src.label_en                                    as source,
  o.course_duration_days,
  (o.delivered_at at time zone 'Asia/Kolkata')::date as delivered_on,
  -- "Gold Plus 30N×1, Power Drive×3", or NULL where the source sheet never
  -- recorded a product breakdown (D-062) — shown as unknown, not as empty.
  items.products,
  -- What the tablets in the parcel say the course is worth: 60N a month, 30N a
  -- fortnight. max(), so a parcel holding both lasts as long as the longer one.
  items.tablet_course_days,
  -- The tablets first, the sheet's own column second, fifteen days last.
  coalesce(items.tablet_course_days, o.course_duration_days, 15) as effective_course_days,
  -- Delivery day, or the order plus a week when the courier date was never
  -- written down. Must agree with v_delivery_lag in fn_generate_ai_daily_leads
  -- and with medicineEnds() in src/app/(app)/rrr/lib/format.ts.
  coalesce((o.delivered_at at time zone 'Asia/Kolkata')::date,
           (o.created_at at time zone 'Asia/Kolkata')::date + 7) as course_started_on,
  coalesce((o.delivered_at at time zone 'Asia/Kolkata')::date,
           (o.created_at at time zone 'Asia/Kolkata')::date + 7)
    + coalesce(items.tablet_course_days, o.course_duration_days, 15) as medicine_ends_on,
  -- True whenever either stand-in was used, so a screen can mark the date as a
  -- guess rather than presenting it as the courier's word.
  (o.delivered_at is null
   or coalesce(items.tablet_course_days, o.course_duration_days) is null) as medicine_ends_estimated
from orders o
left join payment_modes pm on pm.id = o.payment_mode_id
left join lead_sources src on src.id = o.source_id
left join lateral (
  select string_agg(p.name || coalesce(' ' || p.variant, '') || '×' || oi.quantity,
                    ', ' order by p.sort_order)                as products,
         max(p.default_course_days)                            as tablet_course_days
  from order_items oi
  join products p on p.id = oi.product_id
  where oi.order_id = o.id
) items on true;

comment on view v_rrr_customer_orders is
  'One customer''s order history for the RRR detail panel. products is NULL when the source sheet had no per-product columns for that order. medicine_ends_on is the one definition of when a course runs out: delivery (or order + 7) plus the tablets'' own course length (or the recorded one, or 15).';

-- ---------------------------------------------------------------------------
-- The generator, rebuilt from the live definition so that 030's even deal,
-- 031's carry-over and the outcome rules patched in since all survive.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_generate_ai_daily_leads(p_run_on date DEFAULT NULL::date, p_force boolean DEFAULT false)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_role     user_role := app_role();
  v_uid      uuid      := auth.uid();
  v_run_on   date      := coalesce(p_run_on, ist_today());
  -- The sheet's own "Cooldown Until" is selection date + 7 days.
  v_cooldown int := 7;
  -- A missed call is not a cooldown, but it is not tomorrow either: three
  -- days, up to three attempts, then the ordinary rules take over again.
  v_retry_gap  int := 3;
  v_retry_days int := 14;
  v_retry_max  int := 3;
  -- A second attempt is worth a daily slot only while the customer is still
  -- in a band that converts. 029 shipped without this and the retry bucket
  -- filled with people whose last order averaged 223 days ago — a 3% band
  -- being re-dialled at the expense of the 28% one.
  v_retry_age  int := 90;
  -- The parcel takes about a week to arrive, and nobody takes a tablet they
  -- have not received. Median 6 days, mean 7.0, over the 130 delivered orders
  -- carrying both dates. Must agree with medicineEnds() in rrr/lib/format.ts.
  v_delivery_lag int := 7;
  -- "followup to usko hoga jis medicine khatam hogyi h ya medicine ko khatam
  -- hone m 3-4 din bache ha" — so three days of grace, no more.
  v_grace      int := 3;
  -- Unfinished work. How far back to look for leads that were dealt and never
  -- called, and how much of a rep's day yesterday's leftovers may take before
  -- fresh refill-window customers start losing their slots.
  v_carry_days int := 3;
  v_carry_pct  int := 60;
  -- A "no" is worth respecting for twenty days, not for a quarter: it is
  -- usually "not this week", and the next course runs out long before a
  -- quarter is up.
  v_reject   int := 20;
  -- Past this there is no evidence a phone call does anything: 289 calls to
  -- this group produced zero orders. They are reached by WhatsApp instead,
  -- and whoever answers comes back onto a list through the ordinary rules.
  v_max_age  int := 365;
  -- The top decile by lifetime value, recomputed every run so the book tracks
  -- the base instead of a number someone typed once.
  v_top_ltv  numeric;
  v_total    int;
  v_count    int;
begin
  if v_uid is not null
     and (v_role is null or v_role not in ('admin','ceo','coo','auditor')) then
    raise exception 'Not permitted to generate the AI lead list.' using errcode = '42501';
  end if;

  if exists (select 1 from ai_lead_runs where run_on = v_run_on) and not p_force then
    return (select total from ai_lead_runs where run_on = v_run_on);
  end if;

  delete from ai_lead_runs where run_on = v_run_on;   -- cascades to the leads

  select coalesce(sum(coalesce(u.daily_lead_cap, 15)), 0)::int
    into v_total
  from users u
  where u.is_active
    and u.role in ('sales_exec','sales_manager')
    and coalesce(u.daily_lead_cap, 15) > 0;

  select percentile_cont(0.9) within group (order by c.lifetime_value)
    into v_top_ltv
  from customers c
  where c.merged_into_id is null and c.lifetime_orders > 0;

  insert into ai_lead_runs (run_on, generated_by, total) values (v_run_on, v_uid, 0);
  if v_total = 0 then
    return 0;
  end if;

  with reps as (
    select u.id,
           coalesce(u.daily_lead_cap, 15) as cap,
           row_number() over (order by u.full_name) as rep_no
    from users u
    where u.is_active
      and u.role in ('sales_exec','sales_manager')
      and coalesce(u.daily_lead_cap, 15) > 0
  ),
  -- Dealt like cards, not cut into blocks: rank 1,2,3 go to rep A,B,C, then
  -- 4,5,6, so the best leads of the day are spread evenly instead of all
  -- landing on whoever sorts first. Every rep's fifteen therefore carries the
  -- same mix, which is also the only way to ever learn which rep is actually
  -- better — today they cannot be compared, because they are not being dealt
  -- the same quality of list.
  slots as (
    select r.id as owner_id,
           (row_number() over (order by s.slot_no, r.rep_no))::int as slot
    from reps r, lateral generate_series(1, r.cap) as s(slot_no)
  ),
  eligible as (
    select
      c.id                                             as customer_id,
      c.lifetime_value,
      c.lifetime_orders,
      (c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date                            as last_order_on,
      coalesce(v_run_on - (c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date, 9999) as days_since_order,
      fu.next_due_on,
      fu.last_outcome,
      fu.last_done,
      fu.attempts,
      src.label_en                                     as source_label,
      -- How long the medicine actually lasts, decided by the tablets that went
      -- in the parcel: 60N is a month, 30N a fortnight (see
      -- products.default_course_days). The sheet's own course_duration_days is
      -- second, not first — 232 orders carry a recorded 15 against a 60N box,
      -- typed by habit, and a fortnight's clock on a month's medicine is a
      -- call two weeks early. 15 is the last resort, for the 1,044 older
      -- orders that have no product breakdown at all (D-062).
      coalesce(lo.tablet_course_days, lo.course_duration_days, 15) as course_days,
      -- The day the course started. Not the day the order was placed.
      coalesce(lo.delivered_on,
               (c.last_order_at at time zone 'Asia/Kolkata')::date + v_delivery_lag)
                                                       as course_started_on
    from customers c
    left join lateral (
      select
        (min(f.due_at at time zone 'Asia/Kolkata')
           filter (where f.completed_at is null))::date            as next_due_on,
        max(f.completed_at at time zone 'Asia/Kolkata')::date      as last_done,
        count(*) filter (where f.completed_at is not null)         as attempts,
        (array_agg(f.outcome order by f.completed_at desc nulls last)
           filter (where f.completed_at is not null))[1]           as last_outcome
      from followups f
      where f.customer_id = c.id
    ) fu on true
    left join lateral (
      select o.source_id,
             o.course_duration_days,
             (o.delivered_at at time zone 'Asia/Kolkata')::date as delivered_on,
             (select max(p.default_course_days)
                from order_items oi
                join products p on p.id = oi.product_id
               where oi.order_id = o.id)                        as tablet_course_days
      from orders o
      where o.customer_id = c.id
      order by o.created_at desc
      limit 1
    ) lo on true
    left join lead_sources src on src.id = lo.source_id
    where c.merged_into_id is null
      and c.lifetime_orders > 0        -- RRR is repeat business (025)
      and not c.is_dnd
      and not exists (select 1 from public.rrr_work_items w where w.customer_id = c.id and w.completed_at is null)
      -- Nothing older than a year. This is the single biggest change in 029.
      and coalesce(v_run_on - (c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date, 9999) <= v_max_age
      -- The medicine is still in their hands. Ringing on day 3 to sell the
      -- next course is how a customer learns to stop picking up.
      and coalesce(v_run_on - (c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date, 9999) >= 7
      -- Somebody rang them this week already — unless they did not pick up,
      -- in which case one day is the wait, not seven. That exception is the
      -- whole point of the retry bucket: without it the cooldown quietly
      -- forbids the second attempt that connects 46% of the time.
      and (
        fu.last_done is null
        or fu.last_done <= v_run_on - v_cooldown
        or (coalesce(fu.last_outcome, '') = 'no_answer'
            and fu.last_done <= v_run_on - v_retry_gap
            and fu.last_done >  v_run_on - v_retry_days
            and coalesce(fu.attempts, 0) < v_retry_max
            and coalesce(v_run_on - (c.last_order_at AT TIME ZONE 'Asia/Kolkata')::date, 9999) <= v_retry_age)
      )
      -- They said no, or the number is not theirs.
      and not (coalesce(fu.last_outcome, '') in ('not_interested', 'wrong_number')
               and fu.last_done > v_run_on - v_reject)
      -- They told us how much medicine they still have, and the follow-up
      -- that call booked is dated the day it runs out. Until then there is
      -- nothing to sell them and nothing to ask.
      and not (coalesce(fu.last_outcome, '') = 'medicine_not_finished'
               and fu.next_due_on is not null
               and fu.next_due_on > v_run_on)
      -- 028 also excluded anyone who had merely APPEARED on a list in the
      -- last week. Appearing on a list is not contact: on 11 Sep that rule was
      -- hiding 88 customers who had been dealt out on the 9th and 10th and
      -- never rung — 19 of them promised callbacks scoring 78, the best leads
      -- in the system. The cooldown that matters is fu.last_done above, which
      -- counts calls that actually happened; unworked names come back through
      -- `carried` below, to the rep who already had them.
  ),
  windowed as (
    select e.*,
           -- Opens five days before the course runs dry and stays open ten
           -- days after. Counted from the day the course started rather than
           -- the day the order was placed, which is the whole of this change:
           -- on the order clock every refill call landed a week early, and a
           -- customer with 25 days of medicine in the cupboard read as
           -- "Refill due — 15-day course, ordered 12 days ago".
           --
           -- No day-7 floor any more. That floor existed because day 0 used to
           -- be the order; now day 0 is the delivery, and a 7-day combo has to
           -- be allowed to reach its own window.
           e.course_started_on + e.course_days             as medicine_ends_on,
           coalesce(v_run_on - e.course_started_on, -9999) as days_since_start,
           greatest(0, e.course_days - 5)  as refill_from,
           e.course_days + 10              as refill_to
    from eligible e
  ),
  scored_all as (
    select
      w.*,
      -- Exactly one bucket each, first match wins, in the order the numbers
      -- put them. Website buyers are no longer a bucket of their own (028's
      -- `kamour`): they now sort by recency like everyone else, and the fact
      -- that no rep ever spoke to them is said in the reason text instead.
      case
        when w.days_since_start between w.refill_from and w.refill_to  then 'refill'
        when coalesce(w.last_outcome, '') = 'no_answer'
         and w.last_done > v_run_on - v_retry_days
         and coalesce(w.attempts, 0) < v_retry_max
         and w.days_since_order <= v_retry_age                         then 'retry'
        when w.next_due_on is not null and w.next_due_on <= v_run_on   then 'overdue'
        when w.lifetime_value >= v_top_ltv                             then 'topbook'
        when w.days_since_order <= 60                                  then 'slipping'
        when w.days_since_order <= 90                                  then 'cooling'
        when w.lifetime_value >= 10000 or w.lifetime_orders >= 2       then 'revival'
        else                                                                'cooling'
      end as bucket,
      -- Out of 100, and every part of it is something a rep can be told:
      --   refill window   30  (the band that returns 28 orders per 100 calls)
      --   worth        up to 30  (LTV, capped at 12k)
      --   repeat habit up to 20  (4+ orders maxes it)
      --   a promise       20     (a follow-up date that has passed)
      --   second attempt  10     (46% connect, against 35% on the first)
      least(100,
        case when w.days_since_start between w.refill_from and w.refill_to then 30 else 0 end
      + least(30, floor(w.lifetime_value / 400))
      + least(20, w.lifetime_orders * 5)
      + case when w.next_due_on is not null and w.next_due_on <= v_run_on then 20 else 0 end
      + case when coalesce(w.last_outcome, '') = 'no_answer'
              and w.last_done > v_run_on - v_retry_days then 10 else 0 end
      )::int as priority_score,
      concat_ws(' · ',
        case when w.days_since_start between w.refill_from and w.refill_to
             then 'Refill due — ' || w.course_days || '-day course, medicine '
                  || case when w.medicine_ends_on <= v_run_on then 'ran out ' else 'runs out ' end
                  || to_char(w.medicine_ends_on, 'DD Mon') end,
        case when coalesce(w.last_outcome, '') = 'no_answer'
              and w.last_done > v_run_on - v_retry_days
              and w.days_since_order <= v_retry_age
             then 'Did not pick up on ' || to_char(w.last_done, 'DD Mon')
                  || ' — attempt ' || (coalesce(w.attempts, 0) + 1) end,
        case when w.next_due_on is not null and w.next_due_on <= v_run_on
             then 'Follow-up promised for ' || to_char(w.next_due_on, 'DD Mon') end,
        case when w.lifetime_value >= v_top_ltv
             then 'Top 10% customer — ₹' || round(w.lifetime_value)::text || ' lifetime' end,
        case when coalesce(w.attempts, 0) = 0
             then 'Never been called' end,
        case when w.lifetime_orders >= 2
             then w.lifetime_orders || ' orders already' end
      ) as reason
    from windowed w
  ),
  -- The medicine is still in the cupboard.
  --
  -- User, 21 Sep 2026, on a lead whose course ran to 16 Oct: "why is there a
  -- need to take followup — followup to usko hoga jis medicine khatam hogyi h
  -- ya medicine ko khatam hone m 3-4 din bache ha."
  --
  -- The refill window was only ever one branch of the bucket CASE below.
  -- `slipping` means nothing more than "ordered within 60 days", `topbook`
  -- nothing more than "worth a lot", and the top-up fills the tail of the day
  -- from whoever scores best — so a customer three days into a month's course
  -- could arrive by three separate routes. On 21 Sep 2026, 8 of the day's 45
  -- leads still had more than a week of medicine in hand, and 6 of those 8
  -- were in `refill`, the one bucket whose entire job is timing.
  --
  -- Two exceptions, and only two. `overdue` is a date the floor itself gave
  -- the customer and `retry` is a call that nobody answered; neither is a
  -- question about medicine, so neither waits for it to run out.
  scored as (
    select s.*
    from scored_all s
    where s.bucket in ('overdue', 'retry')
       or s.medicine_ends_on is null
       or s.medicine_ends_on <= v_run_on + v_grace
  ),
  -- Dealt in the last few days, never called, still worth calling today.
  -- distinct on keeps the most recent dealing, so a lead that sat unworked for
  -- two days is carried once, not twice.
  carried_all as (
    select distinct on (s.customer_id)
           s.customer_id, s.bucket, s.priority_score, l.owner_id, l.run_on as dealt_on,
           concat_ws(' · ', 'Carried over from ' || to_char(l.run_on, 'DD Mon')
                            || ' — not called yet', nullif(s.reason, '')) as reason
    from scored s
    join ai_daily_leads l on l.customer_id = s.customer_id
    join reps r          on r.id = l.owner_id
    where l.run_on < v_run_on
      and l.run_on >= v_run_on - v_carry_days
      and not exists (
        select 1 from followups f
        where f.customer_id = s.customer_id and (f.completed_at AT TIME ZONE 'Asia/Kolkata')::date >= l.run_on)
    order by s.customer_id, l.run_on desc
  ),
  -- Capped, or a rep who took a day off would spend the next one entirely in
  -- the past while today's refill window closes on its own.
  carried as (
    select c.customer_id, c.bucket, c.priority_score, c.reason, c.owner_id
    from (
      select ca.*,
             row_number() over (partition by ca.owner_id
                                order by ca.priority_score desc, ca.customer_id) as rn,
             floor(r.cap * v_carry_pct / 100.0) as carry_cap
      from carried_all ca join reps r on r.id = ca.owner_id
    ) c
    where c.rn <= c.carry_cap
  ),
  ranked as (
    select s.*,
           row_number() over (partition by s.bucket
                              order by s.priority_score desc, s.customer_id) as rn
    from scored s
    where not exists (select 1 from carried_all k where k.customer_id = s.customer_id)
  ),
  -- Shares apply to the slots still open after unfinished work is seated,
  -- not to the whole day, or the buckets would over-claim and the top-up would
  -- silently drop the tail.
  targets as (
    select r.code,
           floor(r.share_pct * greatest(0, v_total - (select count(*) from carried))
                 / 100.0)::int as target
    from ai_lead_rules r
    where r.is_active
  ),
  picked as (
    select r.customer_id, r.bucket, r.priority_score, r.reason
    from ranked r
    join targets t on t.code = r.bucket
    where r.rn <= t.target
  ),
  -- Rounding leftovers, and any bucket that could not fill its share because
  -- it has run out of people. Both are the same problem, so both are solved
  -- once: fill the rest of the day from everyone still eligible, best first.
  -- This matters more under 029 than it did under 028 — `refill` is a small,
  -- fast-moving pool (79 customers today), and on a thin morning the day is
  -- topped up from the next-best names rather than shrinking below 45.
  topup as (
    select s.customer_id, s.bucket, s.priority_score, s.reason
    from scored s
    where not exists (select 1 from picked p where p.customer_id = s.customer_id)
      and not exists (select 1 from carried_all k where k.customer_id = s.customer_id)
    order by s.priority_score desc, s.customer_id
    limit greatest(0, v_total - (select count(*) from carried)
                                - (select count(*) from picked))
  ),
  -- A rep's own slots, lowest first. The carried leads take the first few;
  -- whatever is left of each rep's fifteen goes back into the round-robin, so
  -- the fresh part of the day is still dealt evenly.
  taken as (
    select k.owner_id,
           (row_number() over (partition by k.owner_id
                               order by k.priority_score desc, k.customer_id))::int as seat,
           k.customer_id, k.bucket, k.priority_score, k.reason
    from carried k
  ),
  free_slots as (
    select sl.owner_id, sl.slot,
           (row_number() over (order by sl.slot))::int as free_no
    from slots sl
    where not exists (
      select 1 from taken t
      where t.owner_id = sl.owner_id
        and sl.slot = (select min(s2.slot) + t.seat - 1
                       from slots s2 where s2.owner_id = sl.owner_id))
  ),
  fresh as (
    select x.*,
           (row_number() over (order by coalesce(ru.sort_order, 999),
                                        x.priority_score desc, x.customer_id))::int as deal_no
    from (select * from picked union all select * from topup) x
    left join ai_lead_rules ru on ru.code = x.bucket
  ),
  final as (
    select y.customer_id, y.bucket, y.priority_score, y.reason, y.owner_id,
           -- Unfinished work reads first, then the fresh list by score: a rep
           -- opening the screen sees what they did not get to yesterday at the
           -- top, not buried at #12.
           (row_number() over (order by y.is_carried desc,
                                        y.priority_score desc, y.customer_id))::int as rank
    from (
      select t.customer_id, t.bucket, t.priority_score, t.reason, t.owner_id, true as is_carried
      from taken t
      union all
      select f.customer_id, f.bucket, f.priority_score, f.reason, fs.owner_id, false
      from fresh f join free_slots fs on fs.free_no = f.deal_no
    ) y
  )
  insert into ai_daily_leads
    (run_on, customer_id, rank, bucket, priority_score, reason, owner_id)
  select v_run_on, f.customer_id, f.rank, f.bucket, f.priority_score,
         nullif(f.reason, ''), f.owner_id
  from final f;

  get diagnostics v_count = row_count;
  update ai_lead_runs set total = v_count where run_on = v_run_on;

  return v_count;
end;
$function$;

comment on function fn_generate_ai_daily_leads(date, boolean) is
  'Build one day''s AI call list, aimed at the refill window (029), dealt bucket by bucket so every rep''s fifteen carries the same mix (030), with leads dealt but never called carried back to the same rep first (031), and timed off the day the parcel landed rather than the day the order was placed. Never deals a customer whose medicine has more than three days left, except an overdue promise or an unanswered retry. Idempotent unless p_force. Never lists a customer whose last order is over a year old. Does not change customer ownership.';
