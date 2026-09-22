create table if not exists poc_assignment_log (
  id          bigserial primary key,
  lead_id     uuid not null references poc_leads(id) on delete cascade,
  from_owner  uuid references users(id),
  to_owner    uuid not null references users(id),
  changed_by  uuid not null references users(id),
  changed_at  timestamptz not null default now()
);

create index if not exists poc_assignment_log_lead_idx
  on poc_assignment_log (lead_id, changed_at desc);

alter table poc_assignment_log enable row level security;
alter table poc_assignment_log force row level security;

revoke all on poc_assignment_log from anon, authenticated;
grant select, insert on poc_assignment_log to service_role;
grant usage, select on sequence poc_assignment_log_id_seq to service_role;

create policy poc_assignment_log_read on poc_assignment_log for select to authenticated
  using (
    (select app_can_read_all())
    or changed_by = (select auth.uid())
    or from_owner = (select auth.uid())
    or to_owner = (select auth.uid())
  );

create or replace function fn_assign_poc_leads(p_lead_ids uuid[], p_owner_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role user_role := app_role();
  v_owner_role user_role;
  v_owner_active boolean;
  v_count int;
begin
  if v_actor_role is null or v_actor_role not in ('admin','ceo','coo','sales_manager','auditor') then
    raise exception 'Not permitted to assign POC leads.' using errcode = '42501';
  end if;

  if p_lead_ids is null or array_length(p_lead_ids, 1) is null or array_length(p_lead_ids, 1) > 100 then
    raise exception 'Choose 1 to 100 POC leads.' using errcode = '22023';
  end if;

  select role, is_active into v_owner_role, v_owner_active
  from users where id = p_owner_id;

  if v_owner_role is null or not coalesce(v_owner_active, false) then
    raise exception 'Choose an active salesperson.' using errcode = '22023';
  end if;

  if v_owner_role not in ('sales_exec','sales_manager') then
    raise exception 'POC leads can only be assigned to a salesperson.' using errcode = '22023';
  end if;

  insert into poc_assignment_log (lead_id, from_owner, to_owner, changed_by)
  select id, owner_id, p_owner_id, auth.uid()
  from poc_leads
  where id = any(p_lead_ids)
    and is_active
    and owner_id is distinct from p_owner_id;

  update poc_leads
  set owner_id = p_owner_id,
      updated_at = now()
  where id = any(p_lead_ids)
    and is_active
    and owner_id is distinct from p_owner_id;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function fn_assign_poc_leads(uuid[], uuid) from public, anon;
grant execute on function fn_assign_poc_leads(uuid[], uuid) to authenticated;

create or replace function fn_assign_paid_elementor_leads(p_lead_ids uuid[], p_owner_id uuid)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_role user_role := app_role();
  v_owner_role user_role;
  v_owner_active boolean;
  v_count int;
begin
  if v_actor_role is null or v_actor_role not in ('admin','ceo','coo','sales_manager','auditor') then
    raise exception 'Not permitted to assign Paid Elementor leads.' using errcode = '42501';
  end if;

  if p_lead_ids is null or array_length(p_lead_ids, 1) is null or array_length(p_lead_ids, 1) > 100 then
    raise exception 'Choose 1 to 100 Paid Elementor leads.' using errcode = '22023';
  end if;

  select role, is_active into v_owner_role, v_owner_active
  from users where id = p_owner_id;

  if v_owner_role is null or not coalesce(v_owner_active, false) then
    raise exception 'Choose an active salesperson.' using errcode = '22023';
  end if;

  if v_owner_role not in ('sales_exec','sales_manager') then
    raise exception 'Paid Elementor leads can only be assigned to a salesperson.' using errcode = '22023';
  end if;

  update leads
  set owner_id = p_owner_id
  where id = any(p_lead_ids)
    and channel = 'zoho_legacy'
    and is_junk = false
    and owner_id is distinct from p_owner_id;

  get diagnostics v_count = row_count;

  update customers c
  set current_owner_id = p_owner_id
  from leads l
  where l.id = any(p_lead_ids)
    and l.customer_id = c.id
    and l.channel = 'zoho_legacy'
    and l.is_junk = false
    and c.merged_into_id is null;

  update followups
  set owner_id = p_owner_id
  where lead_id = any(p_lead_ids)
    and kind = 'lead'
    and completed_at is null;

  return v_count;
end;
$$;

revoke all on function fn_assign_paid_elementor_leads(uuid[], uuid) from public, anon;
grant execute on function fn_assign_paid_elementor_leads(uuid[], uuid) to authenticated;

comment on function fn_assign_poc_leads(uuid[], uuid) is
  'Narrow audited bulk assignment path for POC sheet leads.';

comment on function fn_assign_paid_elementor_leads(uuid[], uuid) is
  'Narrow bulk assignment path for Paid Elementor Zoho leads.';
