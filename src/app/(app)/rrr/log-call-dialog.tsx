'use client';

import { useState, useTransition } from 'react';
import { logCall } from './log-call-action';

export type ContactNumber = { id: string; label_en: string };

export type CallTarget = {
  customerId: string;
  name: string;
  phone: string;
  followupId: string | null;
  orderId: string | null;
};

// Same wording and order as the floor's existing form, so nobody has to learn
// a new vocabulary to do the job they already do. `days` pre-fills the next
// follow-up date the way that outcome usually goes; null means "no date
// unless the rep picks one".
const OUTCOMES: { value: string; label: string; hint: string; days: number | null }[] = [
  { value: 'order_placed',          label: 'Order ho gaya',           hint: 'Converted',          days: null },
  { value: 'interested',            label: 'Interested',              hint: 'Order chance high',  days: 3 },
  { value: 'medicine_not_finished', label: 'Medicine khatam nahi hui', hint: 'Course chal raha',   days: 10 },
  { value: 'will_update_later',     label: 'Baad mein batayenge',     hint: 'Date select karein', days: 7 },
  { value: 'no_answer',             label: 'Call not picked / busy',  hint: '3 din baad',         days: 3 },
  { value: 'not_interested',        label: 'Not interested',          hint: '2 month freeze',     days: 60 },
  { value: 'wrong_number',          label: 'Wrong number',            hint: 'Band karein',        days: null },
  { value: 'connected',             label: 'Baat hui',                hint: 'Note likhein',       days: 7 },
];

const addDays = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
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

  function pickOutcome(value: string) {
    setOutcome(value);
    const preset = OUTCOMES.find((o) => o.value === value);
    // Only ever a starting point — the rep can clear or change it.
    setNextOn(preset?.days ? addDays(preset.days) : '');
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
    <div className="crm-dialog rrr-dialog" role="dialog" aria-modal="true" aria-label={`Log call for ${target.name}`}>
      <div className="rrr-dialog-body">
        <h2 className="dialog-title">{target.name}</h2>
        <p className="muted">{target.phone}</p>

        <fieldset className="rrr-outcomes">
          <legend>Call outcome kya raha?</legend>
          {OUTCOMES.map((o) => (
            <button
              key={o.value}
              type="button"
              className={`rrr-outcome ${outcome === o.value ? 'chosen' : ''}`}
              onClick={() => pickOutcome(o.value)}
              aria-pressed={outcome === o.value}
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
