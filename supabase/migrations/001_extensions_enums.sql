-- 001 · extensions, enums, and the shared updated_at trigger
-- Down: supabase/migrations/001_extensions_enums.down.sql

create extension if not exists pgcrypto  with schema extensions;
create extension if not exists citext    with schema extensions;
create extension if not exists pg_cron;

-- Fixed by code paths, not business-editable. See decisions.md D-012.
create type user_role as enum
  ('sales_exec','sales_manager','doctor','ops','coo','ceo','admin');

create type payment_state as enum
  ('unpaid','paid','partial','refunded','failed');

create type order_stage as enum
  ('pending_confirm','confirmed','dispatched','delivered','rto','cancelled');

create type consultation_state as enum ('pending','done','cancelled');

create type followup_kind as enum ('lead','consultation','order','rrr');

create type rrr_touch as enum ('response','mid','repeat_pitch','last_chance');

create type segment_code as enum ('A1','A2','B1','B2','C1','C2');

create type channel as enum
  ('elementor','wati','call','walkin','referral','zoho_legacy','other');

-- Every mutable table gets this trigger.
create or replace function set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Phone normalisation, mirrored from the importer (mapping doc §1.1) so the
-- database and the import can never disagree about identity.
create or replace function to_e164(raw text) returns text
language plpgsql immutable as $$
declare digits text;
begin
  if raw is null then return null; end if;
  digits := regexp_replace(raw, '[^0-9]', '', 'g');
  -- strip country / trunk prefixes, keep the last 10
  if length(digits) > 10 then
    digits := right(digits, 10);
  end if;
  if digits ~ '^[6-9][0-9]{9}$' then
    return '+91' || digits;
  end if;
  return null;   -- caller decides what to do; never guess a phone number
end;
$$;

-- Masking for unassigned leads: 98••••4773
create or replace function mask_phone(e164 text) returns text
language sql immutable as $$
  select case
    when e164 is null or length(e164) < 13 then null
    else substr(e164, 4, 2) || '••••' || right(e164, 4)
  end;
$$;
