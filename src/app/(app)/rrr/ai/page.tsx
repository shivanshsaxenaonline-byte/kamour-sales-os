import { RrrScreen } from '../rrr-screen';
import type { QueryParams } from '../lib/filters';

// Today's list, rebuilt by cron every morning and re-dealt if anyone presses
// Rebuild, so this can never be cached.
export const dynamic = 'force-dynamic';

export default async function RrrAiLeadsPage(
  { searchParams }: { searchParams: Promise<QueryParams> },
) {
  return <RrrScreen mode="ai" params={await searchParams} />;
}
