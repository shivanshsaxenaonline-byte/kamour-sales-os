import { PRIORITY_META, type Priority } from './lib/priority';

const WHY: Record<Priority, string> = {
  p1: 'P1: order ka waqt — course khatam ho raha hai, ya customer ne date di thi',
  p2: 'P2: pichhle 75 din mein order kiya hai',
  p3: 'P3: 76–180 din, lekin high-value customer',
  cold: 'Cold: order rate bahut kam',
};

/** The P1/P2/P3 tag every RRR calling list shows beside the customer. */
export function PriorityPill({ priority, days }: { priority: Priority; days: number | null }) {
  const meta = PRIORITY_META[priority];
  return (
    <span className={`status-pill ${meta.tone}`} title={WHY[priority]}>
      {meta.label}{days != null ? ` · ${days}d` : ''}
    </span>
  );
}
