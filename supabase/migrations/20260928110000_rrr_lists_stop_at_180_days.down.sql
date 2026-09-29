-- Back to a 365-day reach for the AI list.
do $migration$
declare
  v_sig regprocedure := 'public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure;
  v_def text := pg_get_functiondef(v_sig);
begin
  if position('v_max_age  int := 180;' in v_def) = 0 then
    raise exception 'fn_generate_ai_daily_leads no longer declares v_max_age := 180; edit it by hand';
  end if;
  execute replace(v_def, 'v_max_age  int := 180;', 'v_max_age  int := 365;');
end
$migration$;
