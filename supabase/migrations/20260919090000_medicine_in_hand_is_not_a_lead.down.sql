-- Back to dealing a customer seven days after they said their medicine is not finished.
do $$
declare
  definition text;
  nl         text;
  needle     text;
begin
  select pg_get_functiondef('public.fn_generate_ai_daily_leads(date, boolean)'::regprocedure)
    into definition;

  nl := case when position(concat(chr(13), chr(10)) in definition) > 0
             then concat(chr(13), chr(10)) else chr(10) end;
  needle := concat(nl,
    '      -- They told us how much medicine they still have, and the follow-up', nl,
    '      -- that call booked is dated the day it runs out. Until then there is', nl,
    '      -- nothing to sell them and nothing to ask.', nl,
    '      and not (coalesce(fu.last_outcome, '''') = ''medicine_not_finished''', nl,
    '               and fu.next_due_on is not null', nl,
    '               and fu.next_due_on > v_run_on)');

  if position(needle in definition) = 0 then
    raise exception 'AI generator does not carry the medicine-in-hand rule';
  end if;

  execute replace(definition, needle, '');
end $$;
