-- 018 · imported leads have no SLA deadline
--
-- `leads.sla_due_at` defaults to now() + 15 minutes (D-029). The Zoho import
-- inherited that default, so all 15,961 uncontacted historical leads — some from
-- 2023 — showed as rank-1 SLA BREACHES. A rep would open Aaj Ka Kaam on day one
-- to 15,961 red rows and never trust the queue again.
--
-- Same reasoning as D-010: history must not masquerade as today's urgency.
-- The 15-minute clock applies to leads that arrive through the live funnel,
-- where the arrival time is known and the promise is real.
--
-- Down: supabase/migrations/018_legacy_leads_no_sla.down.sql

update leads set sla_due_at = null where channel = 'zoho_legacy';

comment on column leads.sla_due_at is
  'First-response deadline: created_at + 15 minutes. NULL for imported history, which has no SLA. Breach = rank 1 in Aaj Ka Kaam.';
