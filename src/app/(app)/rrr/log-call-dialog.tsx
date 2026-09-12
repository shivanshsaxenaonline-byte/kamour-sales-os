'use client';

import { useState, useTransition } from 'react';
import { logCall } from './log-call-action';
import { istTodayPlus } from './lib/format';
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
  customerId: string;
  name: string;
  phone: string;
  followupId: string | null;
  orderId: string | null;
};

export function LogCallDialog({
  target, numbers, onClose, onSaved,
}: {
  target: CallTarget;
  numbers: ContactNumber[];
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [outcome, setOutcome] = useState('');
  const [numberId, setNumberId] = useState(numbers[0]?.id ?? '');
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
    setError(null);
    startTransition(async () => {
      const result = await logCall({
        customerId: target.customerId,
        followupId: target.followupId,
        orderId: target.orderId,
        outcome,
        note,
        nextDueOn: nextOn || null,
        contactNumberId: numberId || null,
      });
      if (!result.ok) { setError(result.error); return; }
      onSaved(
        result.scheduledNext
          ? `${target.name} — call saved, next follow-up ${nextOn} ko.`
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

        <label htmlFor="rrr-number">Kis number se call hui?</label>
        <select id="rrr-number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
          <option value="">— number nahi bataya —</option>
          {numbers.map((n) => <option key={n.id} value={n.id}>{n.label_en}</option>)}
        </select>

        <label htmlFor="rrr-note">Note (optional)</label>
        <textarea
          id="rrr-note"
          rows={3}
          value={note}
          maxLength={2000}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Customer ne kya kaha…"
        />

        <label htmlFor="rrr-next">Agli follow-up date</label>
        <input
          id="rrr-next"
          type="date"
          value={nextOn}
          onChange={(e) => setNextOn(e.target.value)}
        />
        <p className="muted">Khali chhodenge to koi agla reminder nahi banega.</p>

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
