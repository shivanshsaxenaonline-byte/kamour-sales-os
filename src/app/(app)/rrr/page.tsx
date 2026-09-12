import { RrrScreen } from './rrr-screen';
import type { QueryParams } from './lib/filters';

// The list is per-viewer (RLS decides which customers are visible) and changes
// as soon as anyone assigns, so it is never a build-time snapshot.
export const dynamic = 'force-dynamic';

// The filter, the sort and the page are the URL now, so the server can fetch
// the fifty rows being looked at instead of the whole base.
export default async function RrrPage(
  { searchParams }: { searchParams: Promise<QueryParams> },
) {
  return <RrrScreen mode="all" params={await searchParams} />;
}
