// Follow-up remarks, read the way a person would.

/** Sheet-style remarks read "Status: … | Note: … | Reminder: … | Segment: …";
 *  only Note is something the rep wrote. A plain remark is kept whole. */
export function repNote(remark: string | null) {
  const text = (remark ?? '').trim();
  if (!/^Status:/i.test(text)) return text || null;
  return text.match(/\|\s*Note:\s*([^|]*)/i)?.[1]?.trim() || null;
}

/** Follow-ups the system closes on its own: an order converting, or a delivery
 *  scheduling the next course call. Not a rep's call. */
export const AUTOMATIC_REMARK = /Automatically marked converted|Course follow-up scheduled from deliver/i;
