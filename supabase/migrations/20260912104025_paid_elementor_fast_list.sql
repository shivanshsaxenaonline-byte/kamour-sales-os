-- One indexed database query replaces the six sequential PostgREST requests
-- previously needed to render the Paid Elementor list.
create index if not exists razorpay_paid_elementor_idx
  on razorpay_payments (paid_at desc, id)
  where currency = 'INR'
    and amount = 99
    and status = 'captured'
    and amount_refunded < 99
    and phone_e164 is not null;

create index if not exists leads_paid_elementor_customer_idx
  on leads (customer_id, created_at desc, id)
  where channel = 'zoho_legacy' and is_junk = false;

create index if not exists followups_paid_elementor_lead_idx
  on followups (lead_id, completed_at desc nulls last, created_at desc)
  where kind = 'lead';

create or replace function list_paid_elementor_leads(
  p_viewer_id uuid,
  p_start date default null,
  p_end date default null,
  p_search text default null,
  p_offset integer default 0,
  p_limit integer default 101
)
returns table (
  payment_id text,
  paid_at timestamptz,
  customer_id uuid,
  full_name text,
  phone text,
  lead_id uuid,
  lead_status text,
  salesperson text,
  connection_status text,
  lead_insight text
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
declare
  v_role user_role;
  v_is_active boolean;
begin
  select u.role, u.is_active
    into v_role, v_is_active
  from users u
  where u.id = p_viewer_id;

  if coalesce(v_is_active, false) = false
     or v_role not in ('admin', 'ceo', 'coo', 'sales_manager', 'sales_exec', 'auditor') then
    raise exception 'Access denied' using errcode = '42501';
  end if;

  return query
  with matched as (
    select
      p.id as payment_id,
      p.paid_at,
      c.id as customer_id,
      c.full_name,
      c.phone_e164 as phone,
      l.id as lead_id,
      coalesce(ls.label_en, 'Unknown') as lead_status,
      coalesce(l.zoho_contacted_person, owner.full_name) as salesperson,
      case
        when l.zoho_connection_status is not null then l.zoho_connection_status
        when latest_followup.outcome = 'connected' then 'Connected'
        when latest_followup.outcome = 'no_answer' then 'No answer'
        when latest_followup.outcome = 'busy' then 'Busy'
        when latest_followup.outcome = 'wrong_number' then 'Wrong number'
        when latest_followup.outcome = 'not_interested' then 'Not interested'
        when latest_followup.outcome = 'will_buy' then 'Will buy'
        when latest_followup.outcome = 'order_placed' then 'Order placed'
        when latest_followup.outcome = 'medicine_not_finished' then 'Medicine not finished'
        when latest_followup.outcome = 'will_update_later' then 'Will update later'
        when latest_followup.outcome is not null then initcap(replace(latest_followup.outcome, '_', ' '))
        when l.first_contacted_at is not null then 'Connected'
        else 'Needs follow-up'
      end as connection_status,
      coalesce(l.zoho_lead_insight, latest_followup.remark) as lead_insight
    from razorpay_payments p
    join customers c
      on c.phone_e164 = p.phone_e164
     and c.merged_into_id is null
    join lateral (
      select candidate.*
      from leads candidate
      where candidate.customer_id = c.id
        and candidate.channel = 'zoho_legacy'
        and candidate.is_junk = false
        and (
          v_role in ('admin', 'ceo', 'coo', 'sales_manager', 'auditor')
          or candidate.owner_id = p_viewer_id
        )
      order by candidate.created_at desc, candidate.id
      limit 1
    ) l on true
    left join lead_statuses ls on ls.id = l.status_id
    left join users owner on owner.id = l.owner_id
    left join lateral (
      select f.outcome, f.remark
      from followups f
      where f.lead_id = l.id and f.kind = 'lead'
      order by f.completed_at desc nulls last, f.created_at desc
      limit 1
    ) latest_followup on true
    where p.currency = 'INR'
      and p.amount = 99
      and p.status = 'captured'
      and p.amount_refunded < 99
      and p.phone_e164 is not null
      and (p_start is null or p.paid_at >= (p_start::timestamp at time zone 'Asia/Kolkata'))
      and (p_end is null or p.paid_at < ((p_end + 1)::timestamp at time zone 'Asia/Kolkata'))
      and exists (
        select 1
        from customer_identities ci
        where ci.customer_id = c.id and ci.system = 'zoho'
      )
  )
  select
    m.payment_id,
    m.paid_at,
    m.customer_id,
    m.full_name,
    m.phone,
    m.lead_id,
    m.lead_status,
    m.salesperson,
    m.connection_status,
    m.lead_insight
  from matched m
  where nullif(trim(p_search), '') is null
     or position(
       lower(trim(p_search)) in lower(concat_ws(' ',
         m.full_name,
         m.phone,
         m.payment_id,
         m.lead_status,
         m.salesperson,
         m.connection_status,
         m.lead_insight
       ))
     ) > 0
  order by m.paid_at desc, m.payment_id
  offset greatest(coalesce(p_offset, 0), 0)
  limit least(greatest(coalesce(p_limit, 101), 1), 101);
end;
$$;

revoke all on function list_paid_elementor_leads(uuid, date, date, text, integer, integer)
  from public, anon, authenticated;
grant execute on function list_paid_elementor_leads(uuid, date, date, text, integer, integer)
  to service_role;

comment on function list_paid_elementor_leads(uuid, date, date, text, integer, integer) is
  'Service-only, read-only Paid Elementor list. Enforces viewer role and lead ownership explicitly.';
