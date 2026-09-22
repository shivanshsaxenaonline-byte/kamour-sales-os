import { getPocLeads, getPocOwners, type PocLeadResult, type PocOwner } from './actions';
import { PocScreen } from './screen';

export const dynamic = 'force-dynamic';

export default async function Page() {
  let initialData: PocLeadResult | null = null;
  let owners: PocOwner[] = [];
  try {
    [initialData, owners] = await Promise.all([
      getPocLeads({ offset: 0, pageSize: 50 }),
      getPocOwners(),
    ]);
  } catch (error) {
    console.error('[poc] initial load failed', { error });
  }
  return <PocScreen initialData={initialData} owners={owners} />;
}
