-- 032 · Razorpay's own record of every payment, stored as it arrives
--
-- User: "razorpay mere system m integrate hojaye because annual sheet m kabhi
-- kabhi person koi or naam se bhi spell mistake ya kuch kar deta hai ... here
-- we want all data in our system that razorpay ka data aa raha hai in
-- accordance to payment time, number, all metric, aur usko hum phir use kar
-- lenge baad me match karke."
--
-- So this table is deliberately NOT clever. It stores what Razorpay says,
-- exactly, and links it to an order only when somebody or something decides
-- the link is real. The alternative — guessing a match at ingest on amount and
-- a phone number — is how a payment ends up silently attached to the wrong
-- order, and a wrong link in a money table is worse than no link at all. Same
-- principle as import_rejects (D-011): anything that cannot be understood is
-- kept and reported, never guessed.
--
-- Why this is worth having even though Razorpay is only 5% of recent orders
-- (30 of the last 180 days' 605, against 36.5% across all time): it is the
-- only payment channel that can be verified without a human retyping it.
-- 2,021 orders carry razorpay_payment_id on exactly **zero** of them today,
-- while 1,250 are marked paid — so not one rupee in this database can currently
-- be traced back to the gateway that took it.
--
-- Amounts are stored in rupees, not paise. Razorpay sends integer paise; the
-- rest of this schema is numeric rupees, and two units for money in one
-- database is a bug waiting to be written.
--
-- Down: supabase/migrations/032_razorpay_payments.down.sql

create table razorpay_payments (
  -- Razorpay's own payment id, pay_xxxxxxxx. Primary key, so replaying a
  -- webhook or re-running the backfill can never double-count a payment.
  id                 text primary key,
  razorpay_order_id  text,
  invoice_id         text,

  status             text not null,          -- created / authorized / captured / refunded / failed
  method             text,                   -- upi / card / netbanking / wallet / emi
  captured           boolean not null default false,

  amount             numeric(12,2) not null, -- rupees
  amount_refunded    numeric(12,2) not null default 0,
  fee                numeric(12,2),
  tax                numeric(12,2),
  currency           text not null default 'INR',

  email              text,
  contact_raw        text,
  -- The join key the floor actually has. Generated, not written by the caller,
  -- so the webhook and the backfill cannot disagree about identity — and NULL
  -- when Razorpay sends something that is not an Indian mobile, because
  -- to_e164 never guesses (001).
  phone_e164         text generated always as (to_e164(contact_raw)) stored,

  vpa                text,                   -- the UPI id, where method = upi
  bank               text,
  wallet             text,
  card_last4         text,
  description        text,
  notes              jsonb,
  acquirer_data      jsonb,                  -- rrn / upi_transaction_id — the bank's own reference

  error_code         text,
  error_description  text,

  -- Razorpay's created_at, which is the moment the money moved. The column the
  -- user asked for by name: "in accordance to payment time".
  paid_at            timestamptz not null,

  -- Everything Razorpay sent, verbatim. Fields this schema does not model yet
  -- are not lost, and a future question can be answered without asking
  -- Razorpay again.
  raw                jsonb not null,

  -- --- matching, which happens later and on purpose ---------------------
  order_id           uuid references orders(id) on delete set null,
  customer_id        uuid references customers(id) on delete set null,
  matched_at         timestamptz,
  matched_by         uuid references users(id),   -- NULL when a job matched it
  match_note         text,

  source             text not null check (source in ('webhook', 'backfill')),
  received_at        timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create trigger trg_razorpay_payments_updated before update on razorpay_payments
  for each row execute function set_updated_at();

-- Matching by phone and by amount-near-a-date are the two things anyone will
-- ever do with this table, plus "show me what is still unmatched".
create index on razorpay_payments (phone_e164) where phone_e164 is not null;
create index on razorpay_payments (paid_at desc);
create index on razorpay_payments (status);
create index on razorpay_payments (order_id) where order_id is not null;
create index on razorpay_payments (amount, paid_at);
create index on razorpay_payments (razorpay_order_id) where razorpay_order_id is not null;
create index on razorpay_payments (received_at) where matched_at is null;

comment on table razorpay_payments is
  'Razorpay''s own record of every payment, stored verbatim (032). Written by the razorpay-webhook Edge Function and by scripts/import-razorpay.mjs. Deliberately unmatched at ingest: order_id and customer_id are filled in later, by a person or a job that decided the link is real. Amounts are rupees, converted from Razorpay''s paise.';
comment on column razorpay_payments.phone_e164 is
  'Generated from contact_raw by to_e164, so it agrees with customers.phone_e164 and can be joined directly. NULL when Razorpay sent something that is not an Indian mobile number.';
comment on column razorpay_payments.raw is
  'The full payment entity as Razorpay sent it. Never trimmed — the whole point of this table is that the gateway''s version survives whatever a human typed into a sheet.';

-- ---------------------------------------------------------------------------
-- Money is not ordinary list data: only the roles that already see everything
-- can read it, and nothing in the app writes it. Both writers (the Edge
-- Function and the importer) hold the service-role key, which bypasses RLS.
-- ---------------------------------------------------------------------------
alter table razorpay_payments enable row level security;

create policy razorpay_payments_read on razorpay_payments
  for select to authenticated
  using ((select app_can_read_all()));

-- ---------------------------------------------------------------------------
-- Every webhook delivery, before anything is done with it. Razorpay retries a
-- failed delivery, and a signature that does not verify must still leave a
-- trace — an endpoint that silently drops what it rejects cannot be debugged
-- at two in the morning.
-- ---------------------------------------------------------------------------
create table razorpay_events (
  id            uuid primary key default gen_random_uuid(),
  event_id      text,                  -- Razorpay's x-razorpay-event-id header
  event         text,                  -- payment.captured, order.paid, refund.created …
  payment_id    text,
  signature_ok  boolean not null,
  handled       boolean not null default false,
  error         text,
  payload       jsonb not null,
  received_at   timestamptz not null default now()
);
create index on razorpay_events (received_at desc);
create index on razorpay_events (event_id) where event_id is not null;
create index on razorpay_events (payment_id) where payment_id is not null;

alter table razorpay_events enable row level security;
create policy razorpay_events_read on razorpay_events
  for select to authenticated
  using ((select app_can_read_all()));

comment on table razorpay_events is
  'Raw webhook deliveries from Razorpay, including ones whose signature failed. Kept so a missing payment can be traced to whether it arrived at all.';

-- ---------------------------------------------------------------------------
-- What a person opens to do the matching. Candidates, not conclusions: it
-- offers the orders that could plausibly be this payment and leaves the
-- decision to whoever is looking.
-- ---------------------------------------------------------------------------
create view v_razorpay_unmatched with (security_invoker = true) as
select
  p.id                as payment_id,
  p.paid_at,
  p.amount,
  p.method,
  p.status,
  p.vpa,
  p.contact_raw,
  p.phone_e164,
  p.email,
  c.id                as likely_customer_id,
  c.full_name         as likely_customer,
  c.lifetime_orders,
  -- Orders from the same phone, for the same money, within a fortnight either
  -- way. Listed, counted, and left alone.
  cand.candidate_orders,
  cand.candidate_count
from razorpay_payments p
left join customers c
       on c.phone_e164 = p.phone_e164
      and c.merged_into_id is null
left join lateral (
  select count(*)::int as candidate_count,
         array_agg(o.id order by abs(extract(epoch from o.created_at - p.paid_at))) as candidate_orders
  from orders o
  where o.customer_id = c.id
    and abs(o.amount - p.amount) < 1
    and o.created_at between p.paid_at - interval '14 days'
                         and p.paid_at + interval '14 days'
) cand on true
where p.matched_at is null
  and p.status in ('captured', 'refunded');

comment on view v_razorpay_unmatched is
  'Payments nobody has linked to an order yet, with the customer the phone number points at and the orders that could plausibly be it. Candidates only — this view never decides.';
