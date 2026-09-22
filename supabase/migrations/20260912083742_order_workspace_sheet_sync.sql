-- Order workspace fields plus an idempotent bridge from the temporary Google
-- Sheet. Supabase remains the application source of truth; the bridge records
-- the last source snapshot so unchanged sheet cells cannot overwrite a later
-- dashboard edit.

alter table orders
  add column order_notes text,
  add column ad_code text,
  add column gclid text;

alter table consultations
  add column taken_by_id uuid references users(id);

create index consultations_taken_by_id_idx on consultations (taken_by_id)
  where taken_by_id is not null;

create table sheet_order_sync_sources (
  sheet_id          text not null,
  tab_name          text not null,
  last_started_at   timestamptz,
  last_finished_at  timestamptz,
  last_success_at   timestamptz,
  lock_until        timestamptz,
  rows_seen         int not null default 0,
  rows_created      int not null default 0,
  rows_updated      int not null default 0,
  rows_skipped      int not null default 0,
  last_error        text,
  primary key (sheet_id, tab_name)
);

create table sheet_order_links (
  id                uuid primary key default gen_random_uuid(),
  sheet_id          text not null,
  tab_name          text not null,
  source_row_number int not null check (source_row_number >= 2),
  order_id          uuid not null references orders(id) on delete cascade,
  identity_key      text not null,
  source_snapshot   jsonb not null,
  last_synced_at    timestamptz not null default now(),
  unique (sheet_id, tab_name, source_row_number),
  unique (order_id)
);
create index sheet_order_links_source_idx
  on sheet_order_links (sheet_id, tab_name, source_row_number);

alter table sheet_order_sync_sources enable row level security;
alter table sheet_order_sync_sources force row level security;
alter table sheet_order_links enable row level security;
alter table sheet_order_links force row level security;

revoke all on sheet_order_sync_sources from anon, authenticated;
revoke all on sheet_order_links from anon, authenticated;
grant select, insert, update on sheet_order_sync_sources to service_role;
grant select, insert, update, delete on sheet_order_links to service_role;

create or replace function claim_sheet_order_sync(p_sheet_id text, p_tab_name text)
returns boolean
language plpgsql
security invoker
set search_path = public
as $$
declare
  claimed boolean := false;
begin
  insert into sheet_order_sync_sources (
    sheet_id, tab_name, last_started_at, lock_until, last_error
  ) values (
    p_sheet_id, p_tab_name, now(), now() + interval '5 minutes', null
  )
  on conflict (sheet_id, tab_name) do update set
    last_started_at = excluded.last_started_at,
    lock_until = excluded.lock_until,
    last_error = null
  where (
      sheet_order_sync_sources.lock_until is null
      or sheet_order_sync_sources.lock_until < now()
    )
    and (
      sheet_order_sync_sources.last_success_at is null
      or sheet_order_sync_sources.last_success_at < now() - interval '90 seconds'
    )
  returning true into claimed;

  return coalesce(claimed, false);
end;
$$;
revoke all on function claim_sheet_order_sync(text, text) from public, anon, authenticated;
grant execute on function claim_sheet_order_sync(text, text) to service_role;

-- Ops edits fulfilment data, including the product lines packed for an order.
-- Oversight remains read-only; the restrictive policy closes a pre-existing
-- route where an auditor could mutate order_items through PostgREST directly.
drop policy if exists order_items_write on order_items;
create policy order_items_write on order_items for all to authenticated
  using (exists (
    select 1 from orders o
    where o.id = order_items.order_id
      and (
        o.current_owner_id = (select auth.uid())
        or (select app_can_read_all())
        or ((select app_role()) = 'ops'
            and o.stage in ('confirmed','dispatched','delivered','rto'))
      )
  ))
  with check (exists (
    select 1 from orders o
    where o.id = order_items.order_id
      and (
        o.current_owner_id = (select auth.uid())
        or (select app_can_read_all())
        or (select app_role()) = 'ops'
      )
  ));

create policy auditor_no_order_items_insert on order_items as restrictive
  for insert to authenticated with check ((select app_can_write()));
create policy auditor_no_order_items_update on order_items as restrictive
  for update to authenticated
  using ((select app_can_write())) with check ((select app_can_write()));
create policy auditor_no_order_items_delete on order_items as restrictive
  for delete to authenticated using ((select app_can_write()));

create or replace function save_order_workspace(
  p_order_id uuid,
  p_version timestamptz,
  p_patch jsonb,
  p_items jsonb default null
)
returns table(updated_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_role text := (select app_role())::text;
  v_updated_at timestamptz;
begin
  if v_role is null or v_role not in ('sales_exec','sales_manager','ops','admin') then
    raise exception 'Your role has read-only access to this order.';
  end if;
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'Invalid order changes.';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_patch) as key
    where key not in (
      'stage','payment_state','payment_mode_id','source_id','amount','discount',
      'shipping_amount','cod_amount','course_duration_days','ship_name',
      'ship_address','ship_pincode','ship_city','ship_state','courier_id','awb',
      'dispatch_date','delivered_at','rto_at','is_repeat','order_notes','ad_code',
      'gclid','order_date'
    )
  ) then
    raise exception 'Unsupported order field.';
  end if;

  update orders set
    stage = case when p_patch ? 'stage'
      then (p_patch->>'stage')::order_stage else stage end,
    payment_state = case when p_patch ? 'payment_state'
      then (p_patch->>'payment_state')::payment_state else payment_state end,
    payment_mode_id = case when p_patch ? 'payment_mode_id'
      then nullif(p_patch->>'payment_mode_id','')::uuid else payment_mode_id end,
    source_id = case when p_patch ? 'source_id'
      then nullif(p_patch->>'source_id','')::uuid else source_id end,
    amount = case when p_patch ? 'amount'
      then (p_patch->>'amount')::numeric else amount end,
    discount = case when p_patch ? 'discount'
      then (p_patch->>'discount')::numeric else discount end,
    shipping_amount = case when p_patch ? 'shipping_amount'
      then (p_patch->>'shipping_amount')::numeric else shipping_amount end,
    cod_amount = case when p_patch ? 'cod_amount'
      then nullif(p_patch->>'cod_amount','')::numeric else cod_amount end,
    course_duration_days = case when p_patch ? 'course_duration_days'
      then (p_patch->>'course_duration_days')::int else course_duration_days end,
    ship_name = case when p_patch ? 'ship_name'
      then nullif(btrim(p_patch->>'ship_name'),'') else ship_name end,
    ship_address = case when p_patch ? 'ship_address'
      then nullif(btrim(p_patch->>'ship_address'),'') else ship_address end,
    ship_pincode = case when p_patch ? 'ship_pincode'
      then nullif(regexp_replace(p_patch->>'ship_pincode','\D','','g'),'') else ship_pincode end,
    ship_city = case when p_patch ? 'ship_city'
      then nullif(btrim(p_patch->>'ship_city'),'') else ship_city end,
    ship_state = case when p_patch ? 'ship_state'
      then nullif(btrim(p_patch->>'ship_state'),'') else ship_state end,
    courier_id = case when p_patch ? 'courier_id'
      then nullif(p_patch->>'courier_id','')::uuid else courier_id end,
    awb = case when p_patch ? 'awb'
      then nullif(btrim(p_patch->>'awb'),'') else awb end,
    dispatch_date = case when p_patch ? 'dispatch_date'
      then nullif(p_patch->>'dispatch_date','')::date else dispatch_date end,
    delivered_at = case when p_patch ? 'delivered_at' then
      case when nullif(p_patch->>'delivered_at','') is null then null
      else (p_patch->>'delivered_at')::date::timestamp at time zone 'Asia/Kolkata' end
      else delivered_at end,
    rto_at = case when p_patch ? 'rto_at' then
      case when nullif(p_patch->>'rto_at','') is null then null
      else (p_patch->>'rto_at')::date::timestamp at time zone 'Asia/Kolkata' end
      else rto_at end,
    is_repeat = case when p_patch ? 'is_repeat'
      then (p_patch->>'is_repeat')::boolean else is_repeat end,
    order_notes = case when p_patch ? 'order_notes'
      then nullif(btrim(p_patch->>'order_notes'),'') else order_notes end,
    ad_code = case when p_patch ? 'ad_code'
      then nullif(btrim(p_patch->>'ad_code'),'') else ad_code end,
    gclid = case when p_patch ? 'gclid'
      then nullif(btrim(p_patch->>'gclid'),'') else gclid end,
    created_at = case when p_patch ? 'order_date' then
      (p_patch->>'order_date')::date::timestamp at time zone 'Asia/Kolkata'
      else created_at end
  where id = p_order_id and orders.updated_at = p_version
  returning orders.updated_at into v_updated_at;

  if v_updated_at is null then
    raise exception 'The order changed. Reload it before saving again.';
  end if;

  if p_items is not null then
    if jsonb_typeof(p_items) <> 'array' then
      raise exception 'Invalid product lines.';
    end if;
    if exists (
      select 1
      from jsonb_to_recordset(p_items) as item(product_id uuid, quantity int)
      left join products p on p.id = item.product_id and p.is_active
      where item.product_id is null or item.quantity is null
         or item.quantity < 1 or item.quantity > 99 or p.id is null
    ) then
      raise exception 'Select active products and valid quantities.';
    end if;
    if (
      select count(*) <> count(distinct item.product_id)
      from jsonb_to_recordset(p_items) as item(product_id uuid, quantity int)
    ) then
      raise exception 'A product can appear only once.';
    end if;

    delete from order_items where order_id = p_order_id;
    insert into order_items (order_id, product_id, quantity)
      select p_order_id, item.product_id, item.quantity
      from jsonb_to_recordset(p_items) as item(product_id uuid, quantity int);
  end if;

  return query select v_updated_at;
end;
$$;
revoke all on function save_order_workspace(uuid, timestamptz, jsonb, jsonb)
  from public, anon;
grant execute on function save_order_workspace(uuid, timestamptz, jsonb, jsonb)
  to authenticated;

create or replace view v_orders_list with (security_invoker = true) as
select
  o.id,
  o.order_no,
  o.customer_id,
  c.full_name,
  c.phone_e164 as phone,
  o.amount,
  o.discount,
  o.stage,
  o.payment_state,
  pm.label_en as payment_mode,
  cu.label_en as courier,
  o.awb,
  o.dispatch_date,
  o.course_duration_days,
  o.next_followup_at,
  o.is_repeat,
  o.current_owner_id,
  u.full_name as owner_name,
  o.created_at,
  o.shipping_amount,
  o.delivered_at,
  ls.label_en as source,
  o.order_notes,
  o.ad_code,
  o.gclid
from orders o
join customers c on c.id = o.customer_id
left join payment_modes pm on pm.id = o.payment_mode_id
left join couriers cu on cu.id = o.courier_id
left join lead_sources ls on ls.id = o.source_id
left join users u on u.id = o.current_owner_id
where c.merged_into_id is null;
