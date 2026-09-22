-- Salespeople can pin any assigned lead they are working as a potential lead.
-- The pin is durable: it stays here until someone removes it manually, even if
-- the daily calling task later closes or gets reassigned.

create table public.potential_leads (
  id uuid primary key default gen_random_uuid(),
  rrr_work_id uuid references public.rrr_work_items(id) on delete set null,
  wati_work_id uuid references public.wati_work_items(id) on delete set null,
  source text not null check (source in ('ai', 'medicine_ending', 'due', 'wati_interested')),
  customer_id uuid references public.customers(id) on delete set null,
  order_id uuid references public.orders(id) on delete set null,
  display_name text not null,
  phone_e164 text not null,
  order_no text,
  note text,
  marked_by uuid not null references public.users(id),
  marked_at timestamptz not null default now(),
  removed_by uuid references public.users(id),
  removed_at timestamptz,
  updated_at timestamptz not null default now()
);

create unique index potential_leads_one_active_customer
  on public.potential_leads(customer_id)
  where customer_id is not null and removed_at is null;
create unique index potential_leads_one_active_prospect_phone
  on public.potential_leads(phone_e164)
  where customer_id is null and removed_at is null;
create index potential_leads_active_by_marker
  on public.potential_leads(marked_by, marked_at desc)
  where removed_at is null;
create index potential_leads_active_by_time
  on public.potential_leads(marked_at desc)
  where removed_at is null;
create index potential_leads_rrr_work
  on public.potential_leads(rrr_work_id)
  where rrr_work_id is not null;
create index potential_leads_wati_work
  on public.potential_leads(wati_work_id)
  where wati_work_id is not null;
create trigger trg_potential_leads_updated before update on public.potential_leads
  for each row execute function public.set_updated_at();

alter table public.potential_leads enable row level security;
revoke all on public.potential_leads from anon;
grant select on public.potential_leads to authenticated;
revoke insert, update, delete, truncate, references, trigger
  on public.potential_leads from authenticated;

create policy potential_leads_read on public.potential_leads
  for select to authenticated
  using (
    removed_at is null
    and (
      marked_by = (select auth.uid())
      or (select app_can_read_all())
    )
  );

create or replace function public.fn_mark_potential_lead(
  p_rrr_work_id uuid default null,
  p_wati_work_id uuid default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_role user_role := public.app_role();
  v_existing uuid;
  v_source text;
  v_customer_id uuid;
  v_order_id uuid;
  v_display_name text;
  v_phone_e164 text;
  v_order_no text;
  v_note text;
  v_id uuid;
begin
  if v_role is null or v_role not in ('sales_exec', 'sales_manager') then
    raise exception 'Only salespeople can mark potential leads.' using errcode = '42501';
  end if;
  if (p_rrr_work_id is null and p_wati_work_id is null)
     or (p_rrr_work_id is not null and p_wati_work_id is not null) then
    raise exception 'Choose exactly one assigned lead.' using errcode = '22023';
  end if;

  if p_rrr_work_id is not null then
    select w.source, w.customer_id, w.order_id, c.full_name, c.phone_e164,
           o.order_no, null::text
      into v_source, v_customer_id, v_order_id, v_display_name, v_phone_e164,
           v_order_no, v_note
    from public.rrr_work_items w
    join public.customers c on c.id = w.customer_id
    join public.orders o on o.id = w.order_id
    where w.id = p_rrr_work_id
      and w.assigned_to = (select auth.uid())
      and w.completed_at is null;

    if v_customer_id is null then
      raise exception 'This RRR lead is not assigned to you.' using errcode = '42501';
    end if;
  else
    select 'wati_interested', w.customer_id, null::uuid,
           coalesce(c.full_name, w.display_name),
           coalesce(c.phone_e164, w.phone_e164),
           null::text, w.primary_concern
      into v_source, v_customer_id, v_order_id, v_display_name, v_phone_e164,
           v_order_no, v_note
    from public.wati_work_items w
    left join public.customers c on c.id = w.customer_id
    where w.id = p_wati_work_id
      and w.assigned_to = (select auth.uid())
      and w.completed_at is null;

    if v_display_name is null then
      raise exception 'This WATI lead is not assigned to you.' using errcode = '42501';
    end if;
  end if;

  select p.id into v_existing
  from public.potential_leads p
  where p.removed_at is null
    and (
      (v_customer_id is not null and p.customer_id = v_customer_id)
      or (v_customer_id is null and p.customer_id is null and p.phone_e164 = v_phone_e164)
      or (p_rrr_work_id is not null and p.rrr_work_id = p_rrr_work_id)
      or (p_wati_work_id is not null and p.wati_work_id = p_wati_work_id)
    )
  order by p.marked_at desc
  limit 1;

  if v_existing is not null then
    return v_existing;
  end if;

  insert into public.potential_leads
    (rrr_work_id, wati_work_id, source, customer_id, order_id, display_name,
     phone_e164, order_no, note, marked_by)
  values
    (p_rrr_work_id, p_wati_work_id, v_source, v_customer_id, v_order_id,
     coalesce(nullif(trim(v_display_name), ''), 'Potential lead'),
     v_phone_e164, v_order_no, nullif(trim(v_note), ''), (select auth.uid()))
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.fn_mark_potential_lead(uuid, uuid) from public, anon;
grant execute on function public.fn_mark_potential_lead(uuid, uuid) to authenticated;

create or replace function public.fn_remove_potential_lead(
  p_potential_id uuid
) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
begin
  update public.potential_leads p
     set removed_at = now(),
         removed_by = (select auth.uid()),
         updated_at = now()
   where p.id = p_potential_id
     and p.removed_at is null
     and (
       p.marked_by = (select auth.uid())
       or (select app_can_read_all())
     )
  returning p.id into v_id;

  if v_id is null then
    raise exception 'Potential lead not found, or you cannot remove it.'
      using errcode = '42501';
  end if;

  return true;
end;
$$;

revoke all on function public.fn_remove_potential_lead(uuid) from public, anon;
grant execute on function public.fn_remove_potential_lead(uuid) to authenticated;

comment on table public.potential_leads is
  'Sales-marked potential leads. Rows stay active until manually removed.';
