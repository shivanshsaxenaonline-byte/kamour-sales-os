import { RrrScreen } from '../rrr-screen';

// Today's list, rebuilt by cron every morning and re-dealt if anyone presses
// Rebuild, so this can never be cached.
export const dynamic = 'force-dynamic';

export default function RrrAiLeadsPage() {
  return <RrrScreen mode="ai" />;
}
