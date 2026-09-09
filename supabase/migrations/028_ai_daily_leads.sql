-- 028 · the AI daily lead list: 45 a day, dealt 15/15/15, refreshed every night
--
-- User: "RRR wale section me ek dropdown aana chahiye ki AI Leads hai, aur
-- total 45 daily AI leads aani chahiye, then 15-15-15 teeno ko assign honi
-- chahiye, aur ye leads daily refresh honi chahiye. Ye daily 45 leads kuch na
-- kuch basis pe aani chahiye — like itna percent Kamour, itna percent active,
-- itna percent inactive and all like that."
--
-- The team already runs this by hand in the KM002 sheet's "AI Daily Queue"
-- tab: a dated selection with a rank, a segment, a priority score, a reason,
-- and a seven-day cooldown before the same customer can come round again.
-- 1,575 of those rows are already imported (D-064, D-068). This migration
-- moves that process into the database, keeping the sheet's own vocabulary
-- rather than inventing a second one.
--
-- Three things are deliberately DATA, not code:
--   · the mix          -> ai_lead_rules.share_pct   (an UPDATE, not a deploy)
--   · how many a day   -> users.daily_lead_cap      (15 each; a fourth rep
--                                                    joining makes it 60)
--   · who gets them    -> whoever is an active salesperson that night
-- The bucket *definitions* stay in the function below, because a predicate
-- stored as a data row would mean dynamic SQL. So changing "how much Kamour"
-- is an UPDATE; inventing a brand-new KIND of bucket is a migration. That is
-- the honest split, and it is where the line falls in course_plans too (D-004).
--
-- What this does NOT do: it does not change customers.current_owner_id. A
-- daily calling list is not a transfer of ownership — 45 owner changes a day
-- would churn the base and rewrite incentive attribution, which follows
-- original_owner_id forever. Today's list says who CALLS today; permanent
-- assignment stays with fn_assign_rrr_customers (D-065).
--
-- Down: supabase/migrations/028_ai_daily_leads.down.sql

-- ---------------------------------------------------------------------------
-- The database runs in UTC; the sales floor runs in IST, and "today's list"
-- means today in Delhi. Getting this wrong is not hypothetical here: it is
-- exactly the bug that duplicated the whole call log (D-068, bug 3).
-- ---------------------------------------------------------------------------
create or replace function ist_today() returns date
language sql stable set search_path = public as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

comment on function ist_today() is
  'Today on the sales floor (Asia/Kolkata), not today in UTC. Use this for every day-boundary decision.';

-- ---------------------------------------------------------------------------
-- The mix. share_pct is a share of the day's total, and the codes must match
-- the bucket CASE in fn_generate_ai_daily_leads exactly.
--
-- The starting numbers are not guesses — they are sized against the base as it
-- stands (1,336 RRR customers: 212 active, 181 cooling, 285 dormant, 658 lost,
-- 88 website buyers, 66 overdue follow-ups) so that no bucket is asked for
-- more people than it has to give across a seven-day cooldown.
-- ---------------------------------------------------------------------------
create table ai_lead_rules (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  label_en    text not null,
  label_hi    text,
  share_pct   int  not null check (share_pct between 0 and 100),
  sort_order  int  not null default 100,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create trigger trg_ai_lead_rules_updated before update on ai_lead_rules
  for each row execute function set_updated_at();

insert into ai_lead_rules (code, label_en, label_hi, share_pct, sort_order) values
  -- A date the floor already promised the customer. Nothing outranks that.
  ('overdue', 'Overdue follow-up', 'Overdue follow-up', 20, 10),
  -- Bought on the website with nobody on the phone. 88 of them, and 184 orders
  -- arrived with no owner at all (D-063) — the least-worked group here.
  ('kamour',  'Website buyer',     'Website buyer',     15, 20),
  -- Ordered within 90 days: warm, and near the next course.
  ('active',  'Active buyer',      'Active buyer',      25, 30),
  -- 91-180 days: going cold but not gone.
  ('cooling', 'Cooling off',       'Cooling off',       20, 40),
  -- 181+ days: win-back.
  ('dormant', 'Dormant',           'Dormant',           20, 50)
on conflict (code) do nothing;

alter table ai_lead_rules enable row level security;
create policy ai_lead_rules_read on ai_lead_rules
  for select to authenticated using (true);
-- Changing the mix is a business decision, so it is writable in the product —
-- but only by the roles that already hand out work.
create policy ai_lead_rules_write on ai_lead_rules
  for update to authenticated
  using ((select app_role()) in ('admin','ceo','coo','sales_manager'))
  with check ((select app_role()) in ('admin','ceo','coo','sales_manager'));

comment on table ai_lead_rules is
  'The daily mix. share_pct is a share of the day''s total; codes match the bucket CASE in fn_generate_ai_daily_leads. Shares need not sum to 100 — whatever is left over is filled by score across everyone eligible.';

-- ---------------------------------------------------------------------------
-- One row per day, so "was the list generated, by whom, and when" is a
-- question with an answer. The cron job and the Refresh button both land here.
-- ---------------------------------------------------------------------------
create table ai_lead_runs (
  run_on        date primary key,
  generated_at  timestamptz not null default now(),
  generated_by  uuid references users(id),   -- NULL = the nightly job
  total         int not null default 0
);

alter table ai_lead_runs enable row level security;
create policy ai_lead_runs_read on ai_lead_runs
  for select to authenticated using (true);

comment on column ai_lead_runs.generated_by is
  'Who pressed Refresh. NULL means the nightly cron job produced this list.';

-- ---------------------------------------------------------------------------
-- The list itself.
-- ---------------------------------------------------------------------------
create table ai_daily_leads (
  id              uuid primary key default gen_random_uuid(),
  run_on          date not null references ai_lead_runs(run_on) on delete cascade,
  customer_id     uuid not null references customers(id) on delete cascade,
  rank            int  not null check (rank > 0),
  bucket          text not null references ai_lead_rules(code),
  priority_score  int  not null,
  -- Why this customer is on today's list, in words a rep can read out. The
  -- sheet calls this column "AI Reason" and the floor uses it.
  reason          text,
  owner_id        uuid references users(id),
  created_at      timestamptz not null default now(),
  -- Nobody appears twice in one day's list, so two reps never ring the same
  -- person on the same morning.
  unique (run_on, customer_id)
);
create index on ai_daily_leads (run_on, rank);
create index on ai_daily_leads (owner_id, run_on);
-- app_ai_lead_today() probes exactly this shape, once per candidate row.
create index on ai_daily_leads (customer_id, run_on, owner_id);

alter table ai_daily_leads enable row level security;

comment on table ai_daily_leads is
  'One day''s AI call list: who to ring, why, in what order, and which rep it was dealt to. Written only by fn_generate_ai_daily_leads.';

-- ---------------------------------------------------------------------------
-- A rep must be able to SEE the customers they were dealt.
--
-- customers_read (011/019) says a sales exec sees only customers they own, and
-- most of today's 45 are unowned or owned by someone else. Without this the
-- screen would hand a rep fifteen rows they cannot open. The read is narrow
-- and it expires by itself: only rows on TODAY's list, only the ones dealt to
-- the caller. Tomorrow's regeneration takes it back with no cleanup.
--
-- SECURITY DEFINER for the same reason as app_owns_customer: reading a table
-- inside a policy that the table's own policy depends on would recurse.
-- ---------------------------------------------------------------------------
create or replace function app_ai_lead_today(cid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from ai_daily_leads l
    where l.customer_id = cid
      and l.owner_id    = auth.uid()
      and l.run_on      = ist_today()
  )
$$;

revoke execute on function app_ai_lead_today(uuid) from anon;

create policy ai_daily_leads_read on ai_daily_leads for select to authenticated
  using ((select app_can_read_all()) or owner_id = (select auth.uid()));

-- The role gate keeps the per-row probe off the hot path for everyone else:
-- oversight roles are already satisfied by app_can_read_all() in the first
-- clause, and a doctor or ops user never reaches this branch at all. (019)
drop policy if exists customers_read on customers;
create policy customers_read on customers for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'doctor'     and app_doctor_sees_customer(id))
    or ((select app_role()) = 'ops'        and app_ops_sees_customer(id))
    or ((select app_role()) = 'sales_exec' and app_ai_lead_today(id))
  );

-- Opening an AI lead must show their real order and call history, or the panel
-- lies by omission — that history is the whole reason the panel exists (D-067).
drop policy if exists orders_read on orders;
create policy orders_read on orders for select to authenticated
  using (
    (select app_can_read_all())
    or current_owner_id  = (select auth.uid())
    or original_owner_id = (select auth.uid())
    or ((select app_role()) = 'ops' and stage in ('confirmed','dispatched','delivered','rto'))
    or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
  );

drop policy if exists followups_read on followups;
create policy followups_read on followups for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (select app_can_read_all())
    or ((select app_role()) = 'sales_exec' and app_ai_lead_today(customer_id))
  );

-- Read only. followups_write is untouched, so a rep logging a call still
-- writes a row owned by themselves and nothing else.

-- ---------------------------------------------------------------------------
-- Generating a day's list.
--
-- Idempotent: a second call for a date that already has a list returns the
-- existing count and changes nothing, because a rep's fifteen must not be
-- reshuffled underneath them at 11am. p_force => true rebuilds it deliberately.
-- ---------------------------------------------------------------------------
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

revoke all on function fn_generate_ai_daily_leads(date, boolean) from public;
grant execute on function fn_generate_ai_daily_leads(date, boolean) to authenticated;

comment on function fn_generate_ai_daily_leads(date, boolean) is
  'Build one day''s AI call list and deal it round-robin across the active salespeople. Idempotent unless p_force. Does not change customer ownership.';

-- ---------------------------------------------------------------------------
-- Nightly, before anyone logs in. 23:00 UTC = 04:30 IST.
--
-- Not 20:00 UTC like refresh-segments: that is 01:30 IST, which is still the
-- PREVIOUS day in UTC, so ist_today() would build the list under yesterday's
-- date and the floor would arrive to an empty screen.
-- ---------------------------------------------------------------------------
select cron.schedule(
  'generate-ai-daily-leads', '0 23 * * *',
  $job$select fn_generate_ai_daily_leads()$job$
);

-- ---------------------------------------------------------------------------
-- What the screen reads. Same shape as v_rrr_queue so the RRR table renders
-- either list with one component, plus the columns only a picked lead has.
-- Columns are listed rather than `q.*` because Postgres expands `*` once, at
-- creation: a later change to v_rrr_queue would silently not appear here, and
-- a view that quietly lags the list it mirrors is worse than one that has to
-- be edited on purpose.
-- ---------------------------------------------------------------------------
create view v_rrr_ai_leads with (security_invoker = true) as
select
  l.run_on,
  l.rank,
  l.bucket,
  r.label_en                                      as bucket_label,
  l.priority_score,
  l.reason,
  l.owner_id                                      as ai_owner_id,
  ai_owner.full_name                              as ai_owner_name,
  q.customer_id,
  q.full_name,
  q.phone_e164,
  q.lifetime_orders,
  q.lifetime_value,
  q.aov,
  q.is_repeat_buyer,
  q.last_order_on,
  q.days_since_order,
  q.payment_profile,
  q.current_owner_id,
  q.owner_name,
  q.is_dnd,
  q.attempts,
  q.last_contacted_on,
  q.last_outcome,
  q.next_due_on,
  q.open_followup_id,
  q.last_order_id,
  q.last_order_source
from ai_daily_leads l
join v_rrr_queue q on q.customer_id = l.customer_id
left join ai_lead_rules r on r.code = l.bucket
left join users ai_owner on ai_owner.id = l.owner_id;

comment on view v_rrr_ai_leads is
  'A day''s AI list joined to the RRR row it points at. security_invoker, so a sales exec sees only the leads dealt to them — ai_daily_leads_read and app_ai_lead_today together decide that, not this view.';

-- ---------------------------------------------------------------------------
-- Fifteen each, which is the number the user asked for. Only blanks are
-- filled, so a cap somebody has already tuned by hand survives a re-run.
-- ---------------------------------------------------------------------------
update users set daily_lead_cap = 15
where is_active
  and role in ('sales_exec','sales_manager')
  and daily_lead_cap is null;

-- The cron job first fires at 04:30 IST tomorrow. Without this the screen
-- would be empty from the moment this ships until then, which reads as broken.
select fn_generate_ai_daily_leads();
