import { getPcrAssignees, getPcrLeads, type PcrAssignee, type PcrLeadResult } from './actions';
import { PcrScreen } from './screen';

export const dynamic = 'force-dynamic';

export default async function Page() {
  let initialData: PcrLeadResult | null = null;
  let assignees: PcrAssignee[] = [];
  try {
    [initialData, assignees] = await Promise.all([
      getPcrLeads({ offset: 0, pageSize: 50 }),
      getPcrAssignees(),
    ]);
  } catch (error) {
    console.error('[pcr] initial load failed', { error });
  }
  return <PcrScreen initialData={initialData} assignees={assignees} />;
}
