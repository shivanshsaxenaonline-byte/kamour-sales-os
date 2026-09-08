-- down 012
-- Postgres cannot remove a value from an enum. Reversing this means recreating
-- the type and rewriting every column that uses it — not worth automating for a
-- purely additive change. Any user holding the role must be reassigned first.
--
-- Intentionally a no-op.
select 1;
