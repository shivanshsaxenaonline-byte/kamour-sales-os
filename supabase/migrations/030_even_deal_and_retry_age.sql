-- 030 · two corrections to 029, found by running it
--
-- 029 was applied and today's list regenerated from it. Two things it got
-- wrong, both visible in the first run:
--
-- 1. **The retry bucket filled with old customers.** "Did not pick up in the
--    last 14 days" is a cross-cutting condition, so it caught people whose
--    last order averaged **223 days ago** — the 3% band — and spent nine of
--    the day's slots re-dialling them. A second attempt is worth a slot only
--    while the customer is still inside 90 days; older misses now fall
--    through to their own band and compete on score like everyone else.
--
-- 2. **The three reps did not get the same mix.** The day is dealt like
--    cards against the score order, and a bucket's members are scattered
--    through that order — so the first run gave Ashutosh six refill leads and
--    Shreyansh and Tejasv three each. Everyone got fifteen; they were not the
--    same fifteen. The list is now dealt bucket by bucket, while the rank a
--    rep reads stays in score order. Equal mixes are also the only way the
--    floor can ever tell which rep converts better, which today it cannot.
--
-- Down: supabase/migrations/030_even_deal_and_retry_age.down.sql

create or replace function fn_generate_ai_daily_leads(
  p_run_on date    default null,
  p_force  boolean default false
) returns int
language plpgsql security definer set search_path = public as $$
declare
  v_role     user_role := app_role();
  v_uid      uuid      := auth.uid();
  v_run_on   date      := coalesce(p_run_on, ist_today());
  -- The sheet's own "Cooldown Until" is selection date + 7 days.
  v_cooldown int := 7;
  -- A missed call is not a cooldown. One day, up to three attempts, then the
  -- ordinary rules take over again.
  v_retry_gap  int := 1;
  v_retry_days int := 14;
  v_retry_max  int := 3;
  -- A second attempt is worth a daily slot only while the customer is still
  -- in a band that converts. 029 shipped without this and the retry bucket
  -- filled with people whose last order averaged 223 days ago — a 3% band
  -- being re-dialled at the expense of the 28% one.
  v_retry_age  int := 90;
  -- A "no" is worth respecting for a quarter, not for a week.
  v_reject   int := 90;
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
     and (v_role is null or v_role not in ('admin','ceo','coo','sales_manager','auditor')) then
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
      c.last_order_at::date                            as last_order_on,
      coalesce(v_run_on - c.last_order_at::date, 9999) as days_since_order,
      fu.next_due_on,
      fu.last_outcome,
      fu.last_done,
      fu.attempts,
      src.label_en                                     as source_label,
      -- The course they actually bought, not an assumed fortnight. 15 days is
      -- the fallback because it is what 294 of the 336 orders carrying a
      -- duration are, and because a missing duration must not park a customer
      -- outside every window forever.
      coalesce(lo.course_duration_days, 15)            as course_days
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
      select o.source_id, o.course_duration_days
      from orders o
      where o.customer_id = c.id
      order by o.created_at desc
      limit 1
    ) lo on true
    left join lead_sources src on src.id = lo.source_id
    where c.merged_into_id is null
      and c.lifetime_orders > 0        -- RRR is repeat business (025)
      and not c.is_dnd
      -- Nothing older than a year. This is the single biggest change in 029.
      and coalesce(v_run_on - c.last_order_at::date, 9999) <= v_max_age
      -- The medicine is still in their hands. Ringing on day 3 to sell the
      -- next course is how a customer learns to stop picking up.
      and coalesce(v_run_on - c.last_order_at::date, 9999) >= 7
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
            and coalesce(v_run_on - c.last_order_at::date, 9999) <= v_retry_age)
      )
      -- They said no, or the number is not theirs.
      and not (coalesce(fu.last_outcome, '') in ('not_interested', 'wrong_number')
               and fu.last_done > v_run_on - v_reject)
      -- On a recent day's list already — with the same retry exception, or a
      -- customer who was dealt out yesterday and did not answer could not be
      -- dealt again for a week.
      and not exists (
        select 1 from ai_daily_leads p
        where p.customer_id = c.id
          and p.run_on > v_run_on - v_cooldown
          and not (coalesce(fu.last_outcome, '') = 'no_answer'
                   and coalesce(fu.attempts, 0) < v_retry_max
                   and coalesce(v_run_on - c.last_order_at::date, 9999) <= v_retry_age
                   and p.run_on <= v_run_on - v_retry_gap)
      )
  ),
  windowed as (
    select e.*,
           -- Opens five days before the course runs dry and stays open ten
           -- days after: 10-25 for a fortnight's course, 25-40 for a month's.
           -- The median gap between a customer's first and second order is 26
           -- days, so this is where the second order is actually decided.
           greatest(7, e.course_days - 5)  as refill_from,
           e.course_days + 10              as refill_to
    from eligible e
  ),
  scored as (
    select
      w.*,
      -- Exactly one bucket each, first match wins, in the order the numbers
      -- put them. Website buyers are no longer a bucket of their own (028's
      -- `kamour`): they now sort by recency like everyone else, and the fact
      -- that no rep ever spoke to them is said in the reason text instead.
      case
        when w.days_since_order between w.refill_from and w.refill_to  then 'refill'
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
        case when w.days_since_order between w.refill_from and w.refill_to then 30 else 0 end
      + least(30, floor(w.lifetime_value / 400))
      + least(20, w.lifetime_orders * 5)
      + case when w.next_due_on is not null and w.next_due_on <= v_run_on then 20 else 0 end
      + case when coalesce(w.last_outcome, '') = 'no_answer'
              and w.last_done > v_run_on - v_retry_days then 10 else 0 end
      )::int as priority_score,
      concat_ws(' · ',
        case when w.days_since_order between w.refill_from and w.refill_to
             then 'Refill due — ' || w.course_days || '-day course, ordered '
                  || w.days_since_order || ' days ago' end,
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
  ranked as (
    select s.*,
           row_number() over (partition by s.bucket
                              order by s.priority_score desc, s.customer_id) as rn
    from scored s
  ),
  targets as (
    select r.code, floor(r.share_pct * v_total / 100.0)::int as target
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
    order by s.priority_score desc, s.customer_id
    limit greatest(0, v_total - (select count(*) from picked))
  ),
  final as (
    select x.*,
           -- What the rep reads: the best lead of the day is #1.
           (row_number() over (order by x.priority_score desc, x.customer_id))::int as rank,
           -- Who it is dealt to, which is a different order on purpose.
           -- Dealing by score alone gave every rep fifteen leads but not the
           -- same fifteen: on 029's first run one rep got six refill leads and
           -- the other two got three each, because a bucket's members are
           -- scattered through the score order. Dealing bucket by bucket puts
           -- consecutive names from one bucket on different reps, so each of
           -- the three gets the same mix — which is also the only way to ever
           -- learn which rep actually converts better.
           (row_number() over (order by coalesce(ru.sort_order, 999),
                                        x.priority_score desc, x.customer_id))::int as deal_no
    from (select * from picked union all select * from topup) x
    left join ai_lead_rules ru on ru.code = x.bucket
  )
  insert into ai_daily_leads
    (run_on, customer_id, rank, bucket, priority_score, reason, owner_id)
  select v_run_on, f.customer_id, f.rank, f.bucket, f.priority_score,
         nullif(f.reason, ''), sl.owner_id
  from final f
  join slots sl on sl.slot = f.deal_no;

  get diagnostics v_count = row_count;
  update ai_lead_runs set total = v_count where run_on = v_run_on;

  return v_count;
end;
$$;

comment on function fn_generate_ai_daily_leads(date, boolean) is
  'Build one day''s AI call list, aimed at the refill window (029), and deal it bucket by bucket so every rep''s fifteen carries the same mix (030). Idempotent unless p_force. Never lists a customer whose last order is over a year old, and never spends a retry slot on one over 90 days. Does not change customer ownership.';
