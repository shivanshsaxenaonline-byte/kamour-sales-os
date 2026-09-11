-- Down for 029 · order-focused daily leads
--
-- Puts the 028 mix back (five buckets, 40% of the day aimed at 91+ days) and
-- restores the 028 generator verbatim — including its seven-day cooldown with
-- no retry exception, and no upper age limit on who can be listed.

update ai_lead_rules set is_active = false
where code in ('refill','retry','slipping','topbook','revival');

update ai_lead_rules set is_active = true, share_pct = 20, sort_order = 10 where code = 'overdue';
update ai_lead_rules set is_active = true, share_pct = 15, sort_order = 20 where code = 'kamour';
update ai_lead_rules set is_active = true, share_pct = 25, sort_order = 30 where code = 'active';
update ai_lead_rules set is_active = true, share_pct = 20, sort_order = 40 where code = 'cooling';
update ai_lead_rules set is_active = true, share_pct = 20, sort_order = 50 where code = 'dormant';

comment on table ai_lead_rules is
  'The daily mix. share_pct is a share of the day''s total; codes match the bucket CASE in fn_generate_ai_daily_leads. Shares need not sum to 100 — whatever is left over is filled by score across everyone eligible.';

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
  -- A "no" is worth respecting for a quarter, not for a week.
  v_reject   int := 90;
  v_total    int;
  v_count    int;
begin
  -- v_uid IS NULL means nobody is signed in — the nightly cron job, which runs
  -- as the table owner. A signed-in caller must hold a role that hands out
  -- work. `auditor` is in the list for the same reason it is in
  -- fn_assign_rrr_customers: this screen was built for Alka (D-065, D-067),
  -- and pressing Refresh writes a call list, not a customer's data.
  if v_uid is not null
     and (v_role is null or v_role not in ('admin','ceo','coo','sales_manager','auditor')) then
    raise exception 'Not permitted to generate the AI lead list.' using errcode = '42501';
  end if;

  if exists (select 1 from ai_lead_runs where run_on = v_run_on) and not p_force then
    return (select total from ai_lead_runs where run_on = v_run_on);
  end if;

  delete from ai_lead_runs where run_on = v_run_on;   -- cascades to the leads

  -- How many a day, and for whom. Both come from the team, not from a
  -- constant: every active salesperson gets daily_lead_cap leads, defaulting
  -- to 15. Three of them today, so the day is 45.
  select coalesce(sum(coalesce(u.daily_lead_cap, 15)), 0)::int
    into v_total
  from users u
  where u.is_active
    and u.role in ('sales_exec','sales_manager')
    and coalesce(u.daily_lead_cap, 15) > 0;

  insert into ai_lead_runs (run_on, generated_by, total) values (v_run_on, v_uid, 0);
  if v_total = 0 then
    return 0;   -- nobody active to call them; the run row records that honestly
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
  -- landing on whoever sorts first.
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
      coalesce(v_run_on - c.last_order_at::date, 9999) as days_since_order,
      fu.next_due_on,
      src.code                                         as source_code,
      src.label_en                                     as source_label
    from customers c
    left join lateral (
      select
        (min(f.due_at at time zone 'Asia/Kolkata')
           filter (where f.completed_at is null))::date            as next_due_on,
        max(f.completed_at at time zone 'Asia/Kolkata')::date      as last_done,
        (array_agg(f.outcome order by f.completed_at desc nulls last)
           filter (where f.completed_at is not null))[1]           as last_outcome
      from followups f
      where f.customer_id = c.id
    ) fu on true
    left join lateral (
      select o.source_id from orders o
      where o.customer_id = c.id
      order by o.created_at desc
      limit 1
    ) lo on true
    left join lead_sources src on src.id = lo.source_id
    where c.merged_into_id is null
      and c.lifetime_orders > 0        -- RRR is repeat business (025)
      and not c.is_dnd
      -- Somebody rang them this week already.
      and (fu.last_done is null or fu.last_done <= v_run_on - v_cooldown)
      -- They said no, or the number is not theirs. Ninety days before we ask
      -- again; 'wrong_number' is listed alongside 'not_interested' because the
      -- outcome list (024) offers it, so a row can carry it.
      and not (coalesce(fu.last_outcome, '') in ('not_interested', 'wrong_number')
               and fu.last_done > v_run_on - v_reject)
      -- On a recent day's list already: the sheet's own cooldown rule.
      and not exists (
        select 1 from ai_daily_leads p
        where p.customer_id = c.id and p.run_on > v_run_on - v_cooldown
      )
  ),
  scored as (
    select
      e.*,
      -- Exactly one bucket each, first match wins. Order is the priority
      -- order: a promise already made beats everything, and a website buyer
      -- is picked out before they get lost in the general activity buckets.
      case
        when e.next_due_on is not null and e.next_due_on <= v_run_on then 'overdue'
        when e.source_code in ('kamour_in', 'kamour_shop')           then 'kamour'
        when e.days_since_order <= 90                                then 'active'
        when e.days_since_order <= 180                               then 'cooling'
        else                                                              'dormant'
      end as bucket,
      -- Out of 100, and every part of it is something a rep can be told:
      --   worth        up to 40  (LTV, capped at 10k — the base's p90 is 8.1k)
      --   repeat habit up to 20  (4+ orders maxes it)
      --   a promise       25     (a follow-up date that has passed)
      --   reorder window  15     (25-75 days out, when a course runs down)
      ( least(40, floor(e.lifetime_value / 250))
      + least(20, e.lifetime_orders * 5)
      + case when e.next_due_on is not null and e.next_due_on <= v_run_on then 25 else 0 end
      + case when e.days_since_order between 25 and 75 then 15 else 0 end
      )::int as priority_score,
      concat_ws(' · ',
        case when e.next_due_on is not null and e.next_due_on <= v_run_on
             then 'Follow-up promised for ' || to_char(e.next_due_on, 'DD Mon') end,
        case when e.source_code in ('kamour_in', 'kamour_shop')
             then 'Bought on ' || e.source_label || ' — self-serve, no rep' end,
        case when e.days_since_order between 25 and 75
             then 'Course running out (' || e.days_since_order || ' days since the order)' end,
        case when e.days_since_order > 180 and e.days_since_order < 9999
             then 'Gone quiet for ' || e.days_since_order || ' days' end,
        case when e.lifetime_value >= 8000
             then 'High value: ₹' || round(e.lifetime_value)::text || ' lifetime' end,
        case when e.lifetime_orders >= 2
             then e.lifetime_orders || ' orders already' end
      ) as reason
    from eligible e
  ),
  ranked as (
    select s.*,
           row_number() over (partition by s.bucket
                              order by s.priority_score desc, s.customer_id) as rn
    from scored s
  ),
  targets as (
    -- floor(), so the shares never over-claim the day; whatever is left is
    -- handed to the top-up below.
    select r.code, floor(r.share_pct * v_total / 100.0)::int as target
    from ai_lead_rules r
    where r.is_active
  ),
  -- picked and topup are UNIONed, so both project the same four columns and
  -- nothing else — `ranked.rn` is scaffolding, not part of the answer.
  picked as (
    select r.customer_id, r.bucket, r.priority_score, r.reason
    from ranked r
    join targets t on t.code = r.bucket
    where r.rn <= t.target
  ),
  -- Rounding leftovers, and any bucket that could not fill its share because
  -- it has run out of people. Both are the same problem, so both are solved
  -- once: fill the rest of the day from everyone still eligible, best first.
  -- Without this a thin bucket would silently shrink the day below 45.
  topup as (
    select s.customer_id, s.bucket, s.priority_score, s.reason
    from scored s
    where not exists (select 1 from picked p where p.customer_id = s.customer_id)
    order by s.priority_score desc, s.customer_id
    limit greatest(0, v_total - (select count(*) from picked))
  ),
  final as (
    select x.*,
           (row_number() over (order by x.priority_score desc, x.customer_id))::int as rank
    from (select * from picked union all select * from topup) x
  )
  insert into ai_daily_leads
    (run_on, customer_id, rank, bucket, priority_score, reason, owner_id)
  select v_run_on, f.customer_id, f.rank, f.bucket, f.priority_score,
         nullif(f.reason, ''), sl.owner_id
  from final f
  join slots sl on sl.slot = f.rank;

  get diagnostics v_count = row_count;
  update ai_lead_runs set total = v_count where run_on = v_run_on;

  return v_count;
end;
$$;


comment on function fn_generate_ai_daily_leads(date, boolean) is
  'Build one day''s AI call list and deal it round-robin across the active salespeople. Idempotent unless p_force. Does not change customer ownership.';
