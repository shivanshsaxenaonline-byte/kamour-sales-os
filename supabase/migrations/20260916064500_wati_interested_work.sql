-- WATI Interested: an assignment made on that screen becomes real work here.
--
-- The leads themselves live in a separate Supabase project (wa_leads), which
-- records only an owner_id. That is enough for the WATI app but not for this
-- one: the salesperson works out of /rrr/my, and Alka's day has to be
-- auditable rep by rep. Both need the assignment on this side of the wire.
--
-- Deliberately NOT rrr_work_items. Every task there is anchored to a golden
-- customer AND an order, and followups_one_parent means logging the call needs
-- that order too. An interested WhatsApp chat has neither, and minting a
-- customers row for every one of them would push unqualified prospects into a
-- 51k-row phone-merged golden record. So WATI work gets its own table and its
-- own call log; customers, orders and followups are left untouched. What ties
-- the two together for the eye is the shared "WATI Interested" tag on the
-- salesperson's list, beside AI Lead / Due today / Medicine Ending.
--
-- Down: supabase/migrations/20260916064500_wati_interested_work.down.sql

create table public.wati_work_items (
  id uuid primary key default gen_random_uuid(),
  -- wa_leads.id in the WATI project. No cross-project foreign key is possible,
  -- so the partial unique index below is what stops one lead being handed to
  -- two reps at once.
  wa_lead_id uuid not null,
  phone_e164 text not null,
  display_name text not null,
  lead_source text,
  intent_score integer,
  primary_concern text,
  -- The golden customer already on this number, when there is one. A
  -- convenience for opening their history; a lead with no match still works.
  customer_id uuid references public.customers(id),
  assigned_to uuid not null references public.users(id),
  assigned_by uuid not null references public.users(id),
  assigned_at timestamptz not null default now(),
  due_on date not null default public.ist_today(),
  last_outcome text,
  last_called_at timestamptz,
  medicine_days_left integer check (medicine_days_left between 1 and 365),
  completed_at timestamptz,
  updated_at timestamptz not null default now()
);
create unique index wati_work_one_open_lead on public.wati_work_items(wa_lead_id)
  where completed_at is null;
create index wati_work_by_rep on public.wati_work_items(assigned_to, due_on)
  where completed_at is null;
create index wati_work_by_day on public.wati_work_items(assigned_at desc);
create index wati_work_by_phone on public.wati_work_items(phone_e164);
create index wati_work_by_customer on public.wati_work_items(customer_id)
  where customer_id is not null;
create trigger trg_wati_work_updated before update on public.wati_work_items
  for each row execute function set_updated_at();

-- The call log. followups cannot hold these: followups_one_parent wants a
-- lead, a consultation or an order, and a WATI prospect has none of the three.
create table public.wati_work_calls (
  id uuid primary key default gen_random_uuid(),
  work_id uuid not null references public.wati_work_items(id) on delete cascade,
  owner_id uuid not null references public.users(id),
  outcome text not null,
  note text,
  next_due_on date,
  contact_number_id uuid references public.contact_numbers(id),
  attempt_no integer not null default 1 check (attempt_no > 0),
  called_at timestamptz not null default now()
);
create index wati_calls_by_day on public.wati_work_calls(called_at desc);
create index wati_calls_by_work on public.wati_work_calls(work_id, called_at desc);
create index wati_calls_by_owner on public.wati_work_calls(owner_id, called_at desc);

alter table public.wati_work_items enable row level security;
alter table public.wati_work_calls enable row level security;
grant select on public.wati_work_items to authenticated;
grant select on public.wati_work_calls to authenticated;

-- Same shape as rrr_work_read: a rep sees their own open tasks plus the ones
-- they closed today, so the shared header's progress count stays honest.
create policy wati_work_read on public.wati_work_items for select to authenticated
  using (
    (
      assigned_to = (select auth.uid())
      and (
        completed_at is null
        or (
          last_called_at is not null
          and (last_called_at at time zone 'Asia/Kolkata')::date = public.ist_today()
        )
      )
    )
    or (
      (select app_can_read_all())
      and (select app_role()) not in ('sales_exec', 'sales_manager')
    )
  );
create policy wati_calls_read on public.wati_work_calls for select to authenticated
  using (
    owner_id = (select auth.uid())
    or (
      (select app_can_read_all())
      and (select app_role()) not in ('sales_exec', 'sales_manager')
    )
  );

-- ---------------------------------------------------------------------------
-- Assign. The caller is gated on role in here rather than in the screen, for
-- the same reason fn_assign_rrr_work is: hiding a button is not a permission.
-- Lead details arrive as JSON because the rows they describe live in the other
-- project and this database cannot read them.
-- ---------------------------------------------------------------------------
create function public.fn_assign_wati_work(
  p_assignee_email text, p_leads jsonb
) returns int
language plpgsql security definer set search_path = public as $fn$
declare
  v_role user_role := app_role();
  v_owner uuid;
  v_target_role user_role;
  v_active boolean;
  v_lead jsonb;
  v_phone text;
  v_customer uuid;
  v_count int := 0;
begin
  if v_role is null or v_role not in ('admin','ceo','coo','auditor') then
    raise exception 'Not permitted to assign WATI work.' using errcode = '42501';
  end if;
  if p_leads is null or jsonb_typeof(p_leads) <> 'array'
     or jsonb_array_length(p_leads) = 0 then
    return 0;
  end if;
  if jsonb_array_length(p_leads) > 100 then
    raise exception 'Assign at most 100 WATI leads at a time.' using errcode = '22023';
  end if;

  select u.id, u.role, u.is_active into v_owner, v_target_role, v_active
  from auth.users a join public.users u on u.id = a.id
  where lower(a.email) = lower(p_assignee_email);
  if v_owner is null or v_target_role not in ('sales_exec','sales_manager')
     or not coalesce(v_active, false) then
    raise exception 'Choose an active salesperson.' using errcode = '22023';
  end if;

  for v_lead in select value from jsonb_array_elements(p_leads) loop
    if (v_lead->>'id') is null or (v_lead->>'phone') is null then
      raise exception 'A selected WATI lead is missing its id or number.'
        using errcode = '22023';
    end if;
    -- WATI stores whatever the WhatsApp profile gave it, so the number is
    -- normalised to the golden record's own +91 form before matching. No match
    -- is normal and not an error: most interested chats are new people.
    v_phone := '+91' || right(regexp_replace(v_lead->>'phone', '[^0-9]', '', 'g'), 10);
    select c.id into v_customer from public.customers c
    where c.phone_e164 = v_phone and c.merged_into_id is null;

    insert into public.wati_work_items
      (wa_lead_id, phone_e164, display_name, lead_source, intent_score,
       primary_concern, customer_id, assigned_to, assigned_by)
    values (
      (v_lead->>'id')::uuid,
      v_lead->>'phone',
      coalesce(nullif(trim(v_lead->>'name'), ''), 'WATI lead'),
      nullif(trim(v_lead->>'source'), ''),
      nullif(v_lead->>'intent', '')::int,
      nullif(trim(v_lead->>'concern'), ''),
      v_customer, v_owner, auth.uid())
    on conflict (wa_lead_id) where completed_at is null do update set
      phone_e164 = excluded.phone_e164,
      display_name = excluded.display_name,
      lead_source = excluded.lead_source,
      intent_score = excluded.intent_score,
      primary_concern = excluded.primary_concern,
      customer_id = excluded.customer_id,
      assigned_to = excluded.assigned_to,
      assigned_by = excluded.assigned_by,
      assigned_at = now(),
      due_on = public.ist_today(),
      updated_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$fn$;
revoke all on function public.fn_assign_wati_work(text, jsonb) from public, anon;
grant execute on function public.fn_assign_wati_work(text, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- Log a call. Mirrors fn_log_assigned_rrr_call's contract exactly — same
-- outcomes, same date rules — so the floor's one Log-call dialog can post a
-- WATI task without anyone learning a second set of rules.
-- ---------------------------------------------------------------------------
create function public.fn_log_wati_call(
  p_work_id uuid, p_outcome text, p_note text,
  p_next_due_on date, p_contact_number_id uuid, p_medicine_days_left integer
) returns jsonb
language plpgsql security definer set search_path = public as $fn$
declare
  v_work public.wati_work_items%rowtype;
  v_attempt int;
begin
  if p_outcome not in ('will_buy', 'medicine_not_finished',
      'will_update_later', 'no_answer', 'not_interested', 'connected') then
    raise exception 'Choose a current call outcome.' using errcode = '22023';
  end if;
  if p_outcome = 'medicine_not_finished' then
    if p_medicine_days_left is null or p_medicine_days_left not between 1 and 365 then
      raise exception 'Enter 1 to 365 medicine days remaining.' using errcode = '22023';
    end if;
    if p_next_due_on is distinct from public.ist_today() + p_medicine_days_left then
      raise exception 'Next call must be when the remaining medicine runs out.'
        using errcode = '22023';
    end if;
  elsif p_medicine_days_left is not null then
    raise exception 'Medicine days only apply to medicine not finished.'
      using errcode = '22023';
  end if;
  if p_outcome = 'will_buy'
     and p_next_due_on is distinct from public.ist_today() + 1 then
    raise exception 'Interested customers are due the next day.' using errcode = '22023';
  end if;
  if p_outcome in ('will_update_later', 'connected') and p_next_due_on is null then
    raise exception 'Ask the customer when to call again and choose a date.'
      using errcode = '22023';
  end if;
  if length(coalesce(p_note, '')) > 2000 then
    raise exception 'Note is too long.' using errcode = '22023';
  end if;
  if p_next_due_on is not null and p_next_due_on < public.ist_today() then
    raise exception 'Next follow-up date cannot be in the past.' using errcode = '22023';
  end if;
  if p_contact_number_id is not null and not exists (
    select 1 from public.contact_numbers where id = p_contact_number_id and is_active
  ) then
    raise exception 'Choose an active calling number.' using errcode = '22023';
  end if;

  select * into v_work from public.wati_work_items
    where id = p_work_id and completed_at is null for update;
  if v_work.id is null or v_work.assigned_to is distinct from auth.uid()
     or app_role() not in ('sales_exec','sales_manager') then
    raise exception 'This WATI lead is not assigned to you.' using errcode = '42501';
  end if;
  -- An interested chat can turn out to be someone who already asked not to be
  -- called. The golden record is the one that knows.
  if v_work.customer_id is not null and exists (
    select 1 from public.customers c where c.id = v_work.customer_id and c.is_dnd
  ) then
    raise exception 'This customer is DND and cannot be called.' using errcode = '42501';
  end if;

  select coalesce(max(c.attempt_no), 0) + 1 into v_attempt
    from public.wati_work_calls c where c.work_id = p_work_id;
  insert into public.wati_work_calls
    (work_id, owner_id, outcome, note, next_due_on, contact_number_id, attempt_no)
  values (p_work_id, auth.uid(), p_outcome,
    case when p_outcome = 'medicine_not_finished'
      then concat_ws(' | ', nullif(trim(p_note), ''),
        format('Medicine remaining: %s days', p_medicine_days_left))
      else nullif(trim(p_note), '') end,
    p_next_due_on, p_contact_number_id, v_attempt);

  update public.wati_work_items set
    due_on = coalesce(p_next_due_on, due_on),
    last_outcome = p_outcome,
    last_called_at = now(),
    medicine_days_left = case when p_outcome = 'medicine_not_finished'
      then p_medicine_days_left else null end,
    completed_at = case when p_next_due_on is null then now() else null end,
    updated_at = now()
  where id = p_work_id;

  return jsonb_build_object('scheduledNext', p_next_due_on is not null,
                            'attemptNo', v_attempt);
end;
$fn$;
revoke all on function public.fn_log_wati_call(uuid, text, text, date, uuid, integer)
  from public, anon;
grant execute on function public.fn_log_wati_call(uuid, text, text, date, uuid, integer)
  to authenticated;
