-- A customer who told us how much medicine is left is not a lead until it runs out.
--
-- User, looking at Rajveer's card: "this customer's followup has been done on
-- 17 [Sep] and marked that his 28 day medicine is left, so why is it showing
-- in medicine due? It must start being visible 2-3 days before it will end —
-- and same for all customers."
--
-- The generator's cooldown counts days since the last call (7), so a customer
-- who said on the 17th that they have four weeks of medicine in the cupboard
-- is eligible again on the 24th — three weeks before there is anything to
-- reorder. Ringing then is ringing to ask a question the customer has already
-- answered, and it is how a customer learns to stop picking up.
--
-- fn_log_assigned_rrr_call already refuses this outcome unless the follow-up
-- is dated exactly the day the medicine runs out, so that date is the whole
-- answer: hold them until it arrives, then let the ordinary rules deal them —
-- an open follow-up that has fallen due is worth +20 and lands them in the
-- `overdue` bucket, which is where a promised call belongs.
--
-- Deliberately narrow. A `no_answer` promise is three days out and the retry
-- bucket exists to dial through it; a `not_interested` one is handled by
-- v_reject. This touches the one outcome that states a fact about the medicine
-- itself.
--
-- The Medicine Ending screen learns the same date in the same change, from the
-- follow-up rather than from delivery date + course length.
--
-- Down: supabase/migrations/20260919090000_medicine_in_hand_is_not_a_lead.down.sql
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
  needle := concat(
    '      -- They said no, or the number is not theirs.', nl,
    '      and not (coalesce(fu.last_outcome, '''') in (''not_interested'', ''wrong_number'')', nl,
    '               and fu.last_done > v_run_on - v_reject)');

  if position(needle in definition) = 0 then
    raise exception 'AI generator changed; the medicine-in-hand rule requires review';
  end if;

  execute replace(definition, needle, concat(needle, nl,
    '      -- They told us how much medicine they still have, and the follow-up', nl,
    '      -- that call booked is dated the day it runs out. Until then there is', nl,
    '      -- nothing to sell them and nothing to ask.', nl,
    '      and not (coalesce(fu.last_outcome, '''') = ''medicine_not_finished''', nl,
    '               and fu.next_due_on is not null', nl,
    '               and fu.next_due_on > v_run_on)'));
end $$;

comment on function fn_generate_ai_daily_leads(date, boolean) is
  'Build one day''s AI call list, aimed at the refill window (029), dealt bucket by bucket so every rep''s fifteen carries the same mix (030), with leads dealt but never called carried back to the same rep first (031), and customers who stated how much medicine they still have held until it runs out. Idempotent unless p_force. Never lists a customer whose last order is over a year old. Does not change customer ownership.';
