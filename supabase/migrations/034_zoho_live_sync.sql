-- 034 · give a lead its Zoho identity, so an edit in the CRM can find it
--
-- 033 let the webhook record that something changed. It could not apply the
-- change, because nothing said which row a Zoho record corresponds to:
-- customer_identities maps a Zoho record to a CUSTOMER, but a customer can
-- have several leads, and the importer never recorded which lead came from
-- which record. An edit therefore had no row to update — only a customer to
-- guess inside.
--
-- The link is recoverable rather than lost: the importer set leads.created_at
-- from the record's own Created Time, so (customer, created_at) identifies the
-- lead a Zoho record produced. scripts/backfill-zoho-lead-ids.mjs walks the
-- source export and fills this column in; today that is 52,047 leads against
-- 52,047 Zoho identities, 50,797 of them already unambiguous one-to-one.
--
-- Stored WITH the zcrm_ prefix the export uses, so it matches
-- customer_identities.external_id and one id means one thing everywhere.
--
-- Down: supabase/migrations/034_zoho_live_sync.down.sql

alter table leads add column zoho_record_id text;

comment on column leads.zoho_record_id is
  'Zoho Consultation_Lead record id, zcrm_-prefixed. Set by the importer backfill and by the live webhook sync; null for leads that did not come from Zoho.';

-- Unique, not just indexed: one Zoho record must never map to two leads, or a
-- status edit would update one of them and leave the other saying something
-- else. Partial, so the 156 website leads and everything else that never came
-- from Zoho are not forced to collide on null.
create unique index leads_zoho_record_id_key
  on leads (zoho_record_id) where zoho_record_id is not null;

-- The sync's own lookup: "has this record already produced a lead?"
-- Covered by the unique index above, so no second index is created here.

-- ---------------------------------------------------------------------------
-- The webhook's delivery token.
--
-- Zoho sends back the token registered with the channel on every notification.
-- The route was ignoring it, so anything that knew the URL could write rows
-- into webhook_events. Stored as a setting rather than hard-coded so rotating
-- it is an UPDATE and a channel re-registration, not a deploy.
-- ---------------------------------------------------------------------------
create table if not exists integration_settings (
  key         text primary key,
  value       text not null,
  updated_at  timestamptz not null default now()
);

alter table integration_settings enable row level security;
-- service_role only, like webhook_events (011). No policies: this holds a
-- shared secret and no user-facing screen ever reads it.

comment on table integration_settings is
  'Small key/value store for integration secrets checked server-side. service_role only — never exposed through PostgREST to a signed-in user.';
