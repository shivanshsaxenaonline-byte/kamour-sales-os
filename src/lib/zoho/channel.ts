// Keeping the Zoho watch channel alive.
//
// A Zoho instant-notification channel EXPIRES — a week at most. When it lapses
// there is no error and no bounce: the CRM simply stops calling, and the app
// drifts out of date while every screen still looks fine. That is the worst
// shape a failure can take, so renewal is a scheduled job rather than a
// calendar reminder someone eventually misses.

import { accessToken } from './client';

const API = process.env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.in';
const MODULE = 'Consultation_Lead';

export type Channel = {
  channel_id: string;
  resource_name: string;
  notify_url: string;
  channel_expiry: string;
  events?: string[];
};

/**
 * Zoho wants ISO 8601 with a numeric offset and no milliseconds —
 * "2026-09-19T13:10:52+05:30". A plain toISOString() (…000Z) is refused with
 * "invalid data" on $.watch[0].channel_expiry, which reads like a permissions
 * problem rather than a formatting one. IST because that is the CRM's own zone.
 */
export const expiryIn = (days: number) =>
  new Date(Date.now() + days * 86_400_000 + 5.5 * 3600_000).toISOString().slice(0, 19) + '+05:30';

async function call(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API}/crm/v7/${path}`, {
    method,
    headers: {
      Authorization: `Zoho-oauthtoken ${await accessToken()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let json: unknown;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.status, json: json as Record<string, unknown> };
}

export async function listChannels(): Promise<Channel[]> {
  const { json } = await call('GET', 'actions/watch');
  return ((json.watch as Channel[]) ?? []);
}

/** Days until the Consultation_Lead channel lapses; null when there is none. */
export function daysLeft(channels: Channel[]): number | null {
  const mine = channels.find((c) => c.resource_name === MODULE);
  if (!mine) return null;
  return (new Date(mine.channel_expiry).getTime() - Date.now()) / 86_400_000;
}

/**
 * Push the channel's expiry back out to a week.
 *
 * Renews the existing channel when there is one and registers a fresh channel
 * when there is not, so a lapse that already happened self-heals on the next
 * run instead of needing someone to notice and re-create it by hand.
 */
export async function renewChannel(notifyUrl: string, token: string) {
  const channels = await listChannels();
  const mine = channels.find((c) => c.resource_name === MODULE);

  const watch = [{
    channel_id: mine?.channel_id ?? String(Date.now()),
    events: [`${MODULE}.create`, `${MODULE}.edit`, `${MODULE}.delete`],
    channel_expiry: expiryIn(7),
    token,
    notify_url: notifyUrl,
    // The sync re-fetches every record from Zoho anyway — the notification is
    // only a nudge — so asking for values here would enlarge every delivery
    // for nothing.
    return_affected_field_values: false,
  }];

  const res = await call(mine ? 'PATCH' : 'POST', 'actions/watch', { watch });
  const after = await listChannels();

  return {
    action: mine ? ('renewed' as const) : ('created' as const),
    status: res.status,
    response: res.json,
    expires: after.find((c) => c.resource_name === MODULE)?.channel_expiry ?? null,
    daysLeft: daysLeft(after),
  };
}
