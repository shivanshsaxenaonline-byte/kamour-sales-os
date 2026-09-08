-- 005 · follow-ups as ROWS, the RRR clock as DATA, segments as a nightly job
-- The sheet had Follow-up 1..5 columns and ran out at 5. This has no ceiling.
-- Down: supabase/migrations/005_followups_rrr.down.sql

-- The RRR table from PROJECT.md, stored as rows so a new course length
-- (e.g. 45 days) is an INSERT, not a migration plus a deploy. (D-004)
create table course_plans (
  id           uuid primary key default gen_random_uuid(),
  course_days  int not null check (course_days > 0),
  touch        rrr_touch not null,
  offset_days  int not null check (offset_days > 0),
  unique (course_days, touch)
);

create table followups (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references customers(id) on delete cascade,
  kind             followup_kind not null,
  lead_id          uuid references leads(id) on delete cascade,
  consultation_id  uuid references consultations(id) on delete cascade,
  order_id         uuid references orders(id) on delete cascade,
  rrr_touch        rrr_touch,
  due_at           timestamptz not null,
  owner_id         uuid references users(id),
  outcome          text check (outcome is null or outcome in
                     ('connected','no_answer','busy','wrong_number',
                      'not_interested','will_buy')),
  remark           text,
  next_due_at      timestamptz,
  completed_at     timestamptz,
  attempt_no       int not null default 1 check (attempt_no > 0),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  -- exactly one parent
  constraint followups_one_parent check (
    (case when lead_id         is not null then 1 else 0 end) +
    (case when consultation_id is not null then 1 else 0 end) +
    (case when order_id        is not null then 1 else 0 end) = 1
  ),
  constraint followups_rrr_touch_only_on_rrr
    check ((kind = 'rrr') = (rrr_touch is not null))
);
create index on followups (owner_id, due_at) where completed_at is null;
create index on followups (customer_id, due_at desc);
create index on followups (order_id);
create index on followups (kind, due_at) where completed_at is null;
create trigger trg_followups_updated before update on followups
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------------------
-- The RRR clock fires on dispatch. Reads course_plans, so it needs no edits
-- when a course length is added.
--
-- IMPORTANT: this trigger is disabled during the legacy import and only
-- future-dated touches are backfilled afterwards, or every rep opens Aaj Ka
-- Kaam on day one to thousands of overdue rows. (decisions.md D-010)
-- ---------------------------------------------------------------------------
create or replace function fn_create_rrr_followups() returns trigger
language plpgsql as $$
begin
  if new.dispatch_date is null or old.dispatch_date is not null then
    return new;   -- only on the null -> not-null transition
  end if;

  insert into followups (customer_id, kind, order_id, rrr_touch, due_at, owner_id)
  select new.customer_id,
         'rrr',
         new.id,
         cp.touch,
         (new.dispatch_date + cp.offset_days)::timestamptz,
         new.original_owner_id          -- RRR goes to the original salesperson
  from course_plans cp
  where cp.course_days = new.course_duration_days;

  return new;
end;
$$;

create trigger trg_orders_rrr
  after update of dispatch_date on orders
  for each row execute function fn_create_rrr_followups();

-- ---------------------------------------------------------------------------
-- Segments: stored, not computed per query. A CASE over 50k rows inside every
-- list view is exactly the egress the hard constraints forbid. (D-007)
-- ---------------------------------------------------------------------------
create or replace function fn_refresh_segments() returns void
language sql as $$
  update customers set segment = case
      when current_date - course_ends_at between 0   and 15  then 'A1'
      when current_date - course_ends_at between 16  and 30  then 'A2'
      when current_date - course_ends_at between 31  and 60  then 'B1'
      when current_date - course_ends_at between 61  and 90  then 'B2'
      when current_date - course_ends_at between 91  and 180 then 'C1'
      when current_date - course_ends_at > 180               then 'C2'
      else null
    end::segment_code
  where course_ends_at is not null
    and merged_into_id is null
    and segment is distinct from (case
      when current_date - course_ends_at between 0   and 15  then 'A1'
      when current_date - course_ends_at between 16  and 30  then 'A2'
      when current_date - course_ends_at between 31  and 60  then 'B1'
      when current_date - course_ends_at between 61  and 90  then 'B2'
      when current_date - course_ends_at between 91  and 180 then 'C1'
      when current_date - course_ends_at > 180               then 'C2'
      else null
    end::segment_code);
$$;

-- 01:30 IST = 20:00 UTC previous day. Nightly, after the sales floor closes.
select cron.schedule('refresh-segments', '0 20 * * *', $$select fn_refresh_segments()$$);
