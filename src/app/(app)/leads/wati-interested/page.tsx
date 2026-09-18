import { getWatiInterestedLeads, type WatiInterestedResult } from './actions';
import { WatiInterestedScreen } from './screen';

export const dynamic = 'force-dynamic';

export default async function Page() {
  let initialData: WatiInterestedResult | null = null;
  try {
    initialData = await getWatiInterestedLeads({ offset: 0, pageSize: 50 });
  } catch (error) {
    console.error('[wati-interested] initial load failed', { error });
  }
  return <WatiInterestedScreen initialData={initialData} />;
}
