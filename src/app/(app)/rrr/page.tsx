import { RrrScreen } from './rrr-screen';

// The list is per-viewer (RLS decides which customers are visible) and changes
// as soon as anyone assigns, so it is never a build-time snapshot.
export const dynamic = 'force-dynamic';

export default function RrrPage() {
  return <RrrScreen mode="all" />;
}
