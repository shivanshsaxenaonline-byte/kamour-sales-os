import { PaidElementorScreen } from './screen';
import { getPaidElementorAssignees, getPaidElementorLeads, type PaidElementorAssignee, type PaidElementorResult } from './actions';

export const dynamic = 'force-dynamic';

export default async function Page() {
  let initialData: PaidElementorResult | null = null;
  let assignees: PaidElementorAssignee[] = [];

  try {
    [initialData, assignees] = await Promise.all([
      getPaidElementorLeads({ offset: 0, pageSize: 50 }),
      getPaidElementorAssignees(),
    ]);
  } catch (error) {
    console.error('[paid-elementor] initial load failed', { error });
  }

  return <PaidElementorScreen initialData={initialData} initialStart="" initialEnd="" assignees={assignees} />;
}
