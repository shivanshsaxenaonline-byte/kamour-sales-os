do $$
declare
  definition text;
  ranked_old text := 'where not exists (select 1 from carried_all k where k.customer_id = s.customer_id)';
  ranked_new text := 'where not exists (select 1 from carried k where k.customer_id = s.customer_id)';
  topup_old text := 'and not exists (select 1 from carried_all k where k.customer_id = s.customer_id)';
  topup_new text := 'and not exists (select 1 from carried k where k.customer_id = s.customer_id)';
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;
  if position(ranked_old in definition) = 0 or position(topup_old in definition) = 0 then
    raise exception 'AI generator changed; carry-over rollback requires review';
  end if;
  definition := replace(definition, ranked_old, ranked_new);
  definition := replace(definition, topup_old, topup_new);
  execute definition;
end $$;
