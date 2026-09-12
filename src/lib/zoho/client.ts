// Zoho CRM (India DC) — self-client OAuth.
//
// The refresh token does not expire, so nothing here needs a browser. Access
// tokens last an hour; we cache one in memory and refresh a minute early.
//
// The granted scope is ZohoCRM.modules.custom.READ only: the Consultation Lead
// custom module is readable, the stock Leads/Contacts modules are not. That is
// deliberate — consultation leads are the only thing this app syncs.

const ACCOUNTS = process.env.ZOHO_ACCOUNTS_URL ?? 'https://accounts.zoho.in';
const API = process.env.ZOHO_API_DOMAIN ?? 'https://www.zohoapis.in';

export const CONSULTATION_MODULE = 'Consultation_Lead';

// Field API names for the Consultation Lead module, from /settings/fields.
//
// Do not infer these from the labels — this module's names diverge badly, and
// two of them invert: the field called Lead_Status holds "Connection Status",
// while the actual lead status is Lead_Status1. Gender is Genderr.
export const CONSULTATION_FIELDS = [
  'Name', 'Owner', 'Email', 'Created_Time', 'Modified_Time', 'Last_Activity_Time',
  'Tag', 'Unsubscribed_Mode', 'Unsubscribed_Time', 'Locked__s', 'Date_of_Login',
  'Contact_Number', 'Lead_Status', 'Calling_Done_By', 'Diseases', 'Date_of_Calling',
  'Lead_Status1', 'Consultation_Lead', 'Lead_Source', 'Alternate_Number',
  'Follow_up_Done_By', 'Age', 'Address', 'Follow_up_1_Date', 'Genderr',
  'Date_5', 'Date_6', 'State', 'Lead_Insights', 'Follow_up_2_Done_By',
  'Mode_Of_Connection', 'Chat_Follow_up', 'Important_Notes', 'Profession',
  'Follow_up_4_Done_By', 'Follow_up_3_Done_By', 'Follow_up_Done_On',
  'Follow_up_2_Remark', 'Follow_up_1_Done_On', 'Follow_up_3_Done_On',
  'Follow_up_4_Date', 'Follow_up_3_Remark', 'Follow_up_4_Done_On',
  'Follow_up_4_Remark', 'UTM_Content', 'UTM_Source', 'UTM_Term', 'UTM_Medium',
  'Google_Click_Identifier', 'UTM_Campaign', 'What_s_Your_Concern',
  'First_WhatsApp_Sent', 'Payment_Status',
] as const;

// "Kapeefit Consultations" in the CRM UI — the paid consultations, one row per
// booking, carrying the Razorpay payment id.
export const KAPEEFIT_CONSULTATION_MODULE = 'Online_Consultation';

let cached: { token: string; expires: number } | null = null;

export async function accessToken(): Promise<string> {
  if (cached && Date.now() < cached.expires) return cached.token;

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: process.env.ZOHO_CLIENT_ID!,
    client_secret: process.env.ZOHO_CLIENT_SECRET!,
    refresh_token: process.env.ZOHO_REFRESH_TOKEN!,
  });
  const res = await fetch(`${ACCOUNTS}/oauth/v2/token`, { method: 'POST', body });
  const json = await res.json();
  if (!json.access_token) throw new Error(`zoho refresh failed: ${JSON.stringify(json)}`);

  cached = { token: json.access_token, expires: Date.now() + (json.expires_in - 60) * 1000 };
  return cached.token;
}

export async function zohoGet(path: string, params: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const url = new URL(`${API}/crm/v7/${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const res = await fetch(url, {
    headers: { Authorization: `Zoho-oauthtoken ${await accessToken()}`, ...headers },
  });
  if (res.status === 204) return { data: [], info: { more_records: false } };   // no rows
  const json = await res.json();
  if (!res.ok) throw new Error(`zoho ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// Walks the whole module. v7 pages past 2,000 rows with a page token rather
// than a page number, so the cursor is opaque and we just follow it.
export async function* consultationLeads(opts: { modifiedSince?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.modifiedSince) headers['If-Modified-Since'] = opts.modifiedSince;
  let pageToken: string | undefined;

  do {
    const params: Record<string, string> = {
      fields: CONSULTATION_FIELDS.join(','),
      per_page: '200',
      sort_by: 'Modified_Time',
      sort_order: 'asc',
    };
    if (pageToken) params.page_token = pageToken;

    const json = await zohoGet(CONSULTATION_MODULE, params, headers);
    for (const row of json.data ?? []) yield row;
    pageToken = json.info?.more_records ? json.info.next_page_token : undefined;
  } while (pageToken);
}
