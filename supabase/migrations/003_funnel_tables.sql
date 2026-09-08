-- 003 · leads, consultations, prescriptions
-- Sequence is fixed: Lead → Consultation (₹99) → Prescription → Order → Follow-up → Repeat
-- Down: supabase/migrations/003_funnel_tables.down.sql

create table leads (
  id                   uuid primary key default gen_random_uuid(),
  customer_id          uuid not null references customers(id) on delete cascade,
  source_id            uuid not null references lead_sources(id),
  channel              channel not null default 'other',
  status_id            uuid not null references lead_statuses(id),
  concern_id           uuid references concerns(id),
  -- the ₹99 consult fee. Set by the Razorpay webhook only — there is no
  -- manual "paid" checkbox anywhere in the UI.
  payment_state        payment_state not null default 'unpaid',
  paid_at              timestamptz,
  razorpay_payment_id  text unique,
  amount               numeric(12,2),
  is_junk              boolean not null default false,
  lost_reason_id       uuid references lost_reasons(id),
  owner_id             uuid references users(id),
  sla_due_at           timestamptz,
  first_contacted_at   timestamptz,
  utm_source           text,
  utm_medium           text,
  utm_campaign         text,
  -- raw webhook body. NEVER selected in a list view.
  raw_payload          jsonb,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  constraint leads_paid_needs_timestamp
    check (payment_state <> 'paid' or paid_at is not null)
);
create index on leads (customer_id);
create index on leads (owner_id, payment_state, sla_due_at);
create index on leads (payment_state, created_at desc) where is_junk = false;
create index on leads (status_id);
create trigger trg_leads_updated before update on leads
  for each row execute function set_updated_at();

create table consultations (
  id                uuid primary key default gen_random_uuid(),
  customer_id       uuid not null references customers(id) on delete cascade,
  lead_id           uuid references leads(id) on delete set null,
  doctor_id         uuid references users(id),
  scheduled_at      timestamptz,
  state             consultation_state not null default 'pending',
  completed_at      timestamptz,
  cancel_reason_id  uuid references cancel_reasons(id),
  fee_amount        numeric(12,2),
  fee_state         payment_state not null default 'unpaid',
  notes             text,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  -- a cancelled consultation without a reason is how the sheet lost information
  constraint consult_cancel_reason_required
    check (state <> 'cancelled' or cancel_reason_id is not null),
  constraint consult_done_needs_timestamp
    check (state <> 'done' or completed_at is not null)
);
create index on consultations (customer_id);
create index on consultations (state, scheduled_at desc);
create index on consultations (doctor_id, scheduled_at desc);
create trigger trg_consultations_updated before update on consultations
  for each row execute function set_updated_at();

create table prescriptions (
  id                    uuid primary key default gen_random_uuid(),
  consultation_id       uuid not null references consultations(id) on delete cascade,
  customer_id           uuid not null references customers(id) on delete cascade,
  doctor_id             uuid not null references users(id),
  -- never auto-filled: this drives the RRR clock
  course_duration_days  int not null check (course_duration_days > 0),
  advice                text,
  pdf_r2_key            text,
  issued_at             timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on prescriptions (consultation_id);
create index on prescriptions (customer_id);
create trigger trg_prescriptions_updated before update on prescriptions
  for each row execute function set_updated_at();
