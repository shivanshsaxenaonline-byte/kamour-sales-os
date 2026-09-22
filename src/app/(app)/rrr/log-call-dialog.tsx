'use client';

import { useState, useTransition } from 'react';
import { logCall } from './log-call-action';
import { daysBetween, istToday, istTodayPlus } from './lib/format';
// The buttons, their wording and their pre-filled dates now come from the one
// outcome table in lib/outcomes.ts, which the filter, the timeline and the
// server whitelist all read too. The wording itself is deliberately unchanged:
// PROJECT.md D-053 makes the app English throughout, but this is the floor's
// own form vocabulary on the screen they use all day, so switching it is a
// call for the team to make rather than a side effect of a refactor.
import { OUTCOME_INPUTS } from './lib/outcomes';
import { useModal } from './lib/use-modal';

export type ContactNumber = { id: string; label_en: string };

export type CallTarget = {
  /** Null only for a WATI Interested lead whose number is not in the customer
   *  base yet — there is nothing to open a history against, but the call still
   *  has to be recordable. */
  customerId: string | null;
  name: string;
  phone: string;
  followupId: string | null;
  orderId: string | null;
  workId?: string;
  /** Set instead of workId when the task came from WATI Interested. */
  watiWorkId?: string;
};

export function LogCallDialog({
  target, numbers, preferredNumberId, onClose, onSaved,
}: {
  target: CallTarget;
  numbers: ContactNumber[];
  /** The handset this rep last called from — see fn_my_calling_number. Null
   *  for someone who has never logged a call. */
  preferredNumberId?: string | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState('');
  // Opens on the number the rep last called from, not on whatever sorts first.
  // Still only a default: the select below is theirs to change, and the one
  // they pick is what gets recorded.
  const [numberId, setNumberId] = useState(
    (preferredNumberId && numbers.some((n) => n.id === preferredNumberId)
      ? preferredNumberId
      : numbers[0]?.id) ?? '',
  );
  const [note, setNote] = useState('');
  const [nextOn, setNextOn] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const { ref, onBackdropClick } = useModal(onClose);

  function pickOutcome(value: string) {
    setOutcome(value);
    const preset = OUTCOME_INPUTS.find((o) => o.alias === value);
    // Only ever a starting point — the rep can clear or change it. Counted in
    // IST, like every other date in this module: the old version stepped the
    // machine's own calendar, so a call logged before 05:30 scheduled its
    // follow-up a day early.
    setNextOn(preset?.days ? istTodayPlus(preset.days) : '');
  }

  function save() {
    if (!outcome) { setError('Pehle call outcome chunein.'); return; }
    if (!numberId) { setError('Kis number se call hui? Number chunein.'); return; }
    // The rep picks the day the medicine runs out; the database still records
    // it as days remaining, counted from today.
    const remaining = nextOn ? daysBetween(istToday(), nextOn) : 0;
    if (outcome === 'medicine_not_finished' && (!nextOn || remaining < 1 || remaining > 365)) {
      setError('Customer ki dawai kab khatam hogi? Kal se 1 saal ke andar ki date chunein.');
      return;
    }
    // A missed call with no date closes an assigned task for good, so the
    // customer could not be found again when they rang back.
    if ((outcome === 'will_update_later' || outcome === 'connected' || outcome === 'no_answer') && !nextOn) {
      setError('Customer kab batayenge? Agli follow-up date chunein.');
      return;
    }
    // Today is not a next call. The task would be called-today and still due
    // today, which is a date the rep's own list cannot place: today's calls
    // drop it for having been made, and Upcoming is for dates still ahead.
    // "Shaam ko ring back" is tomorrow's list, or this call is not over yet.
    if (nextOn && nextOn <= istToday()) {
      setError('Agli follow-up date kal ya uske baad ki chunein.');
      return;
    }
    // "Other" is only worth recording if it says what happened — the note is
    // the outcome here, not a decoration on it.
    if (outcome === 'other' && !note.trim()) {
      setError('Call mein kya hua? Note likhein.');
      return;
    }
    // An order is the one claim nobody else can check today: the sheet catches
    // up tomorrow, so the rep's own line about what was ordered is what makes
    // it readable in between.
    if (outcome === 'order_placed' && !note.trim()) {
      setError('Kya order hua? Note likhein.');
      return;
    }
    // Order placed carries no next date at all — the new order raises the next
    // call itself, when its course runs out.
    const nextDueOn = outcome === 'order_placed'
      ? null
      : outcome === 'medicine_not_finished'
        ? nextOn
        : outcome === 'interested' || outcome === 'other' ? istTodayPlus(1) : nextOn || null;
    setError(null);
    startTransition(async () => {
      const result = await logCall({
        customerId: target.customerId,
        followupId: target.followupId,
        orderId: target.orderId,
        outcome,
        note,
        nextDueOn,
        medicineDaysLeft: outcome === 'medicine_not_finished' ? remaining : null,
        contactNumberId: numberId || null,
        workId: target.workId ?? null,
        watiWorkId: target.watiWorkId ?? null,
      });
      if (!result.ok) { setError(result.error); return; }
      onSaved(
        outcome === 'order_placed'
          ? `${target.name} — order noted, yeh task band.`
          : result.scheduledNext
            ? `${target.name} — call saved, next follow-up ${nextDueOn} ko.`
            : `${target.name} — call saved.`,
      );
    });
  }

  return (
    <div className="crm-dialog rrr-dialog" onMouseDown={onBackdropClick}>
      <div
        className="rrr-dialog-body"
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={`Log call for ${target.name}`}
        tabIndex={-1}
      >
        <h2 className="dialog-title">{target.name}</h2>
        <p className="muted">{target.phone}</p>

        <fieldset className="rrr-outcomes">
          <legend>Call outcome kya raha?</legend>
          {OUTCOME_INPUTS.map((o) => (
            <button
              key={o.alias}
              type="button"
              className={`rrr-outcome ${outcome === o.alias ? 'chosen' : ''}`}
              onClick={() => pickOutcome(o.alias)}
              aria-pressed={outcome === o.alias}
            >
              <strong>{o.label}</strong>
              <span className="muted">{o.hint}</span>
            </button>
          ))}
        </fieldset>

        {outcome === 'medicine_not_finished' ? (
          <label htmlFor="rrr-medicine-ends" className="rrr-field">
            <span>Customer ki dawai kab khatam hogi?</span>
            <input id="rrr-medicine-ends" type="date" required
              min={istTodayPlus(1)} max={istTodayPlus(365)}
              value={nextOn} onChange={(event) => setNextOn(event.target.value)} />
            {nextOn && daysBetween(istToday(), nextOn) >= 1
              ? <span className="muted">{daysBetween(istToday(), nextOn)} din ki dawai bachi hai · agla follow-up {nextOn} ko.</span>
              : null}
          </label>
        ) : null}

        <label htmlFor="rrr-number">Kis number se call hui?</label>
        <select id="rrr-number" value={numberId} required onChange={(e) => setNumberId(e.target.value)}>
          <option value="">— number chunein —</option>
          {numbers.map((n) => <option key={n.id} value={n.id}>{n.label_en}</option>)}
        </select>

        <label htmlFor="rrr-note">
          {outcome === 'other' ? 'Note (zaroori) — kya hua?'
            : outcome === 'order_placed' ? 'Note (zaroori) — kya order hua?'
              : 'Note (optional)'}
        </label>
        <textarea
          id="rrr-note"
          rows={3}
          value={note}
          maxLength={2000}
          required={outcome === 'other' || outcome === 'order_placed'}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Customer ne kya kaha…"
        />

        {outcome === 'order_placed' ? (
          <p className="muted">
            Order placed: yeh task band ho jayega aur koi follow-up book nahi hoga.
            Agla call naye order ka course khatam hone par apne aap aayega.
          </p>
        ) : null}
        {outcome === 'interested' ? (
          <p className="muted">Interested: agla follow-up kal, {istTodayPlus(1)} ko.</p>
        ) : null}
        {outcome === 'other' ? (
          <p className="muted">Other: note ke saath kal, {istTodayPlus(1)} ko, dobara action due mein aayega.</p>
        ) : null}
        {outcome === 'will_update_later' || outcome === 'connected' ? (
          <label htmlFor="rrr-next" className="rrr-field">
            <span>Customer kab batayenge? Date chunein</span>
            <input id="rrr-next" type="date" min={istTodayPlus(1)} required
              value={nextOn} onChange={(event) => setNextOn(event.target.value)} />
          </label>
        ) : null}
        {outcome === 'no_answer' || outcome === 'not_interested' ? (
          <label htmlFor="rrr-next" className="rrr-field">
            <span>Agli follow-up date</span>
            <input id="rrr-next" type="date" min={istTodayPlus(1)}
              value={nextOn} onChange={(event) => setNextOn(event.target.value)} />
          </label>
        ) : null}

        {error ? <p className="edit-error" role="alert">{error}</p> : null}

        <div className="rrr-dialog-actions">
          <button type="button" onClick={onClose} disabled={pending}>Cancel</button>
          <button type="button" onClick={save} disabled={pending || !outcome}>
            {pending ? 'Saving…' : 'Save update'}
          </button>
        </div>
      </div>
    </div>
  );
}
