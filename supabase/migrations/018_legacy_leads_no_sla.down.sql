-- down 018
-- Restores an SLA deadline on legacy rows. They will all read as breached again.
update leads set sla_due_at = created_at + interval '15 minutes'
where channel = 'zoho_legacy' and sla_due_at is null;
