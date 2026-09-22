// Where a call on a salesperson's list came from — one vocabulary, so the same
// lead wears the same tag wherever it is seen.
//
// The three RRR sources used to be an inline ternary copied into my-work-list,
// the assigned-work table and nothing else, which is why a fourth source could
// not be added without the two copies drifting. WATI Interested is that fourth
// source: Alka hands a lead over on the WATI screen, and the rep sees it on
// /rrr/my under this tag, beside the RRR work she assigned the same morning.

export type WorkSource = 'ai' | 'due' | 'medicine_ending' | 'wati_interested';

/** `tone` is a .status-pill modifier in crm.css. */
const WORK_SOURCES: Record<WorkSource, { label: string; tone: string }> = {
  ai: { label: 'AI Lead', tone: 'positive' },
  due: { label: 'Due today', tone: 'attention' },
  medicine_ending: { label: 'Medicine Ending', tone: 'attention' },
  // Its own tone rather than a borrowed one: this lead came in from a WhatsApp
  // conversation, not from the order base, and the rep opens it differently.
  wati_interested: { label: 'WATI Interested', tone: 'wati' },
};

export const workSourceLabel = (source: WorkSource) => WORK_SOURCES[source].label;
export const workSourceTone = (source: WorkSource) => WORK_SOURCES[source].tone;
