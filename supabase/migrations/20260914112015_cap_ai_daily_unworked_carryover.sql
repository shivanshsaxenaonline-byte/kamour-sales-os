-- The generator carries at most 60% of each rep's unfinished names, but its
-- fresh pick and top-up still searched the full eligible pool. That let the
-- same unworked names re-enter as "fresh" and bypass the cap. Exclude all
-- unworked names dealt in the last three days from those fresh seats; the
-- capped carried CTE remains their only route onto the day.
do $$
declare
  definition text;
  ranked_old text := 'where not exists (select 1 from carried k where k.customer_id = s.customer_id)';
  ranked_new text := 'where not exists (select 1 from carried_all k where k.customer_id = s.customer_id)';
  topup_old text := 'and not exists (select 1 from carried k where k.customer_id = s.customer_id)';
  topup_new text := 'and not exists (select 1 from carried_all k where k.customer_id = s.customer_id)';
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;
  if position(ranked_old in definition) = 0 or position(topup_old in definition) = 0 then
    raise exception 'AI generator changed; carry-over patch requires review';
  end if;
  definition := replace(definition, ranked_old, ranked_new);
  definition := replace(definition, topup_old, topup_new);
  execute definition;
end $$;
