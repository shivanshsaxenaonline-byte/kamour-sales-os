-- 012 · add the `auditor` role
--
-- The team includes an Auditor (Alka), which none of the seven PROJECT.md roles
-- covers. An auditor reads everything and writes nothing — closest to coo/ceo,
-- but giving a compliance role the COO's identity would make the audit trail lie
-- about who looked at what.
--
-- Alone in its own migration on purpose: a new enum value cannot be USED in the
-- same transaction that adds it. Migration 013 is what starts using it.
--
-- Down: supabase/migrations/012_add_auditor_role.down.sql

alter type user_role add value if not exists 'auditor';
