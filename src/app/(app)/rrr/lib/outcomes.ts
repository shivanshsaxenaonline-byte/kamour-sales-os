// What a call can end as — one vocabulary, keyed by what the database stores.
//
// This existed in four places before: a label map and a tone map copied
// verbatim into rrr-table.tsx and customer-panel.tsx, the dialog's own list of
// buttons in log-call-dialog.tsx, and the accepted-values Set in
// log-call-action.ts. They had already drifted — `busy` is a value the column
// holds, the filter offers and the timeline paints, but the dialog had no
// button that could produce one. Adding an outcome now means adding one row
// here, and the filter, the timeline, the dialog and the server whitelist all
// pick it up together.

export type OutcomeTone = 'positive' | 'attention' | 'critical' | 'neutral';

/** The half a rep fills in. Absent when the outcome exists in the data but is
 *  not something the dialog offers as a button. */
type Input = {
  /** What the dialog posts. Differs from the stored code only for `will_buy`,
   *  which the floor has always called "interested" — the column has stored
   *  `will_buy` since 005, so the two are mapped rather than renamed under
   *  live data. */
  alias: string;
  /** The floor's own wording, deliberately unchanged. See the note in
   *  log-call-dialog.tsx about PROJECT.md D-053. */
  label: string;
  hint: string;
  /** Days ahead to pre-fill a standard follow-up; null means a conditional
   *  field asks for the date or remaining medicine days. */
  days: number | null;
};

type Outcome = { label: string; tone: OutcomeTone; input?: Input };

/** Keyed by the value stored in followups.outcome (the nine migration 024
 *  allows). Order is the order the dialog shows its buttons in. */
const OUTCOME_DEFINITIONS = {
  order_placed: {
    label: 'Order placed', tone: 'positive',
  },
  will_buy: {
    label: 'Interested', tone: 'positive',
    input: { alias: 'interested', label: 'Interested', hint: 'Kal follow-up', days: 1 },
  },
  medicine_not_finished: {
    label: 'Medicine not finished', tone: 'attention',
    input: { alias: 'medicine_not_finished', label: 'Medicine khatam nahi hui', hint: 'Bache hue din batayein', days: null },
  },
  will_update_later: {
    label: 'Will update later', tone: 'attention',
    input: { alias: 'will_update_later', label: 'Baad mein batayenge', hint: 'Kab batayenge? Date chunein', days: null },
  },
  no_answer: {
    label: 'Call not picked', tone: 'attention',
    // Three days, not one. Ringing the same unanswered number tomorrow morning
    // spends a slot on somebody who is simply not picking up this week; the
    // sheet the floor worked from before the cutover left three days too. The
    // AI list's own retry gap is the same three days, so a missed call comes
    // back once, on the same day, whichever route brings it.
    input: { alias: 'no_answer', label: 'Call not picked / busy', hint: '3 din baad dobara try', days: 3 },
  },
  not_interested: {
    label: 'Not interested', tone: 'critical',
    // Twenty days, not sixty. A "no" on the phone is usually a "not this
    // week" — the course they are on has not run out yet, or the money is
    // not there this month. Two months put them back on the list long after
    // the next order would have been due, so the floor asked for the freeze
    // to be a third of that: long enough not to pester, short enough that
    // they come back while the last course is still the one they remember.
    input: { alias: 'not_interested', label: 'Not interested', hint: '20 din freeze', days: 20 },
  },
  wrong_number: {
    label: 'Wrong number', tone: 'critical',
  },
  connected: {
    label: 'Baat hui', tone: 'positive',
    input: { alias: 'connected', label: 'Baat hui', hint: 'Kab batayenge? Date chunein', days: null },
  },
  // Legacy and import-only: the column holds it and the timeline must paint
  // it, but the dialog folds "busy" into "call not picked", so there is no
  // button that writes one.
  busy: { label: 'Busy', tone: 'attention' },
} as const satisfies Record<string, Outcome>;

export const OUTCOMES: Record<keyof typeof OUTCOME_DEFINITIONS, Outcome> =
  OUTCOME_DEFINITIONS;

export type OutcomeCode = keyof typeof OUTCOMES;

/** `as const` gives each entry its own literal type, which is what makes the
 *  code union exact — but it also means the union has no common `input`
 *  property, because `busy` has none. Widening back to Outcome here is how the
 *  optional field is read without losing the exact key union above. */
const entry = (code: OutcomeCode): Outcome => OUTCOMES[code];

/** Every stored code, for the "last call outcome" filter. */
export const OUTCOME_CODES = Object.keys(OUTCOMES) as OutcomeCode[];

/** The buttons the Log-call dialog shows, in order. */
export const OUTCOME_INPUTS = OUTCOME_CODES
  .map((code) => entry(code).input)
  .filter((i): i is Input => !!i);

/** Only current dialog options may be posted. Historical/import-only outcomes
 *  remain in OUTCOMES so old timelines still display correctly. */
export const ALIAS_TO_COLUMN: Record<string, OutcomeCode> = Object.fromEntries([
  ...OUTCOME_CODES.flatMap((code) => {
    const alias = entry(code).input?.alias;
    return alias ? [[alias, code] as const, [code, code] as const] : [];
  }),
]);

const isCode = (v: string): v is OutcomeCode => v in OUTCOMES;

/** Display label for a stored outcome. Unknown codes show themselves rather
 *  than vanishing — an outcome nobody mapped is a data question, not a blank. */
export const outcomeLabel = (code: string | null) =>
  !code ? null : isCode(code) ? OUTCOMES[code].label : code;

export const outcomeTone = (code: string | null): OutcomeTone =>
  code && isCode(code) ? OUTCOMES[code].tone : 'neutral';
