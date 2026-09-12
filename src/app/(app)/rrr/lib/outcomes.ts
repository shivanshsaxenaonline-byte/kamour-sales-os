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
  /** Days ahead to pre-fill the next follow-up date; null = no date unless the
   *  rep picks one. Only ever a starting point. */
  days: number | null;
};

type Outcome = { label: string; tone: OutcomeTone; input?: Input };

/** Keyed by the value stored in followups.outcome (the nine migration 024
 *  allows). Order is the order the dialog shows its buttons in. */
const OUTCOME_DEFINITIONS = {
  order_placed: {
    label: 'Order placed', tone: 'positive',
    input: { alias: 'order_placed', label: 'Order ho gaya', hint: 'Converted', days: null },
  },
  will_buy: {
    label: 'Interested', tone: 'positive',
    input: { alias: 'interested', label: 'Interested', hint: 'Order chance high', days: 3 },
  },
  medicine_not_finished: {
    label: 'Medicine not finished', tone: 'attention',
    input: { alias: 'medicine_not_finished', label: 'Medicine khatam nahi hui', hint: 'Course chal raha', days: 10 },
  },
  will_update_later: {
    label: 'Will update later', tone: 'attention',
    input: { alias: 'will_update_later', label: 'Baad mein batayenge', hint: 'Date select karein', days: 7 },
  },
  no_answer: {
    label: 'Call not picked', tone: 'attention',
    input: { alias: 'no_answer', label: 'Call not picked / busy', hint: '3 din baad', days: 3 },
  },
  not_interested: {
    label: 'Not interested', tone: 'critical',
    input: { alias: 'not_interested', label: 'Not interested', hint: '2 month freeze', days: 60 },
  },
  wrong_number: {
    label: 'Wrong number', tone: 'critical',
    input: { alias: 'wrong_number', label: 'Wrong number', hint: 'Band karein', days: null },
  },
  connected: {
    label: 'Baat hui', tone: 'positive',
    input: { alias: 'connected', label: 'Baat hui', hint: 'Note likhein', days: 7 },
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

/** What the dialog may post, and what each alias stores. Built from the table
 *  above so the server whitelist can never fall behind the buttons. `busy` is
 *  accepted too: migration 024 allows it and imported rows carry it. */
export const ALIAS_TO_COLUMN: Record<string, OutcomeCode> = Object.fromEntries([
  ...OUTCOME_CODES.map((code) => [code, code] as const),
  ...OUTCOME_CODES.flatMap((code) => {
    const alias = entry(code).input?.alias;
    return alias && alias !== code ? [[alias, code] as const] : [];
  }),
]);

const isCode = (v: string): v is OutcomeCode => v in OUTCOMES;

/** Display label for a stored outcome. Unknown codes show themselves rather
 *  than vanishing — an outcome nobody mapped is a data question, not a blank. */
export const outcomeLabel = (code: string | null) =>
  !code ? null : isCode(code) ? OUTCOMES[code].label : code;

export const outcomeTone = (code: string | null): OutcomeTone =>
  code && isCode(code) ? OUTCOMES[code].tone : 'neutral';
