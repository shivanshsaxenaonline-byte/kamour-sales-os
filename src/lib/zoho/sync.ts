// Apply a Zoho change to our own tables.
//
// This is the half that did not exist. 033 gave us a route that recorded a
// notification into webhook_events; 91 of them arrived and sat there, because
// nothing read that table. A Zoho notification carries only record ids and the
// NAMES of the fields that changed — never the new values — so "applying" a
// change always means going back to Zoho for the record and writing it here.
//
//   notification -> fetch those ids -> map -> upsert customer + lead
//
// The mapping is deliberately the same one scripts/import-zoho.mjs used for the
// original 52,177 rows. A live edit and a re-import must not disagree about
// what a record means, so the transforms, the lookup codes and the owner-name
// aliases below are copied from there rather than reinvented.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { CONSULTATION_FIELDS, CONSULTATION_MODULE, zohoGet } from './client';

// ---------------------------------------------------------------- transforms
const norm = (s: string | null | undefined) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const blank = (v: string | null | undefined) =>
  !v || ['-', '--', 'null', 'n/a', 'na'].includes(String(v).trim().toLowerCase());

const toE164 = (raw: string | null | undefined) => {
  let d = String(raw || '').replace(/\D/g, '');
  if (d.length > 10) d = d.slice(-10);
  return /^[6-9]\d{9}$/.test(d) ? `+91${d}` : null;
};

const ts = (v: string | null | undefined) =>
  /^\d{4}-\d{2}-\d{2}/.test(String(v || '')) ? new Date(String(v)).toISOString() : null;

/** "Pankaj Chauhan WATI" and "Pankaj chauhan" are one person. */
const cleanName = (v: string | null | undefined) =>
  String(v || '').replace(/\s*\b(wati|whatsapp|elementor)\b\s*$/i, '').replace(/\s+/g, ' ').trim();

const age = (v: unknown) => {
  const n = Number(String(v ?? '').replace(/\D/g, ''));
  return Number.isInteger(n) && n >= 1 && n <= 120 ? n : null;
};

const gender = (v: string | null | undefined) => {
  const n = norm(v);
  if (['male', 'm', 'mail', 'maleq'].includes(n)) return 'male';
  if (['female', 'f', 'femal', 'feamle', 'femail'].includes(n)) return 'female';
  return null;
};

/** The export prefixes record ids with zcrm_; the API returns them bare. Every
 *  id stored here carries the prefix so customer_identities.external_id and
 *  leads.zoho_record_id mean the same string. */
export const zcrm = (id: string) => (id.startsWith('zcrm_') ? id : `zcrm_${id}`);
const bare = (id: string) => id.replace(/^zcrm_/, '');

/** Zoho record ids are numeric. Anything else in a notification is not a record
 *  — a smoke-test payload, a hand-made curl — and sending it on makes Zoho
 *  reject the WHOLE batch with UNABLE_TO_PARSE_DATA_TYPE, taking the real ids
 *  down with it. */
const isRecordId = (id: string) => /^\d{6,}$/.test(bare(id));

// Same aliases the importer used (D-038).
const NAME_TO_USER: Record<string, string> = {
  shreyansh: 'Shreyansh', tejas: 'Tejasv', tejasv: 'Tejasv', ashutoshpal: 'Ashutosh',
};

// Zoho's Lead_Status1 vocabulary is three values wide — "Need Followup",
// "Converted", and blank — and this is the importer's reading of them.
const STATUS: Record<string, string> = { needfollowup: 'contacted', converted: 'converted' };

type ZohoRecord = Record<string, unknown> & { id: string };

const str = (v: unknown): string | null => {
  if (v == null) return null;
  if (typeof v === 'object') {
    const o = v as { name?: string };
    return o.name ?? null;
  }
  return String(v);
};

export type SyncResult = {
  fetched: number;
  created: number;
  updated: number;
  skipped: { id: string; reason: string }[];
};

/** Service-role client. RLS does not apply to this path on purpose: a webhook
 *  has no signed-in user, and the records it writes belong to whoever Zoho says
 *  owns them, not to the caller. */
export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('server_not_configured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/** Fetch records by id. Zoho caps a request at 100 ids and 50 fields, so the
 *  ids go in hundreds and the fields in two halves joined back on id — the
 *  same split scripts/zoho-pull.mjs makes for the same reason. */
async function fetchRecords(ids: string[]): Promise<ZohoRecord[]> {
  const out: ZohoRecord[] = [];
  const fields = [...CONSULTATION_FIELDS];
  const half = Math.ceil(fields.length / 2);
  const batches = [fields.slice(0, half), fields.slice(half)];

  for (let i = 0; i < ids.length; i += 100) {
    const slice = ids.slice(i, i + 100).map(bare);
    const merged = new Map<string, ZohoRecord>();
    for (const batch of batches) {
      const json = await zohoGet(CONSULTATION_MODULE, {
        ids: slice.join(','),
        fields: batch.join(','),
      });
      for (const row of (json.data ?? []) as ZohoRecord[]) {
        merged.set(row.id, { ...(merged.get(row.id) ?? {}), ...row } as ZohoRecord);
      }
    }
    out.push(...merged.values());
  }
  return out;
}

type Lookups = {
  sources: Record<string, string>;
  concerns: Record<string, string>;
  statuses: Record<string, string>;
  users: Record<string, string>;
};

async function loadLookups(db: SupabaseClient): Promise<Lookups> {
  const [src, con, sta, usr] = await Promise.all([
    db.from('lead_sources').select('id, code'),
    db.from('concerns').select('id, code'),
    db.from('lead_statuses').select('id, code'),
    db.from('users').select('id, full_name'),
  ]);
  const map = (rows: { id: string; code: string }[] | null) =>
    Object.fromEntries((rows ?? []).map((r) => [r.code, r.id]));
  return {
    sources: map(src.data as { id: string; code: string }[] | null),
    concerns: map(con.data as { id: string; code: string }[] | null),
    statuses: map(sta.data as { id: string; code: string }[] | null),
    users: Object.fromEntries(
      ((usr.data ?? []) as { id: string; full_name: string }[])
        .map((u) => [norm(u.full_name), u.id])),
  };
}

const userId = (raw: string | null, users: Record<string, string>) => {
  const n = norm(raw);
  if (!n) return null;
  const alias = NAME_TO_USER[n];
  return (alias ? users[norm(alias)] : users[n]) ?? null;
};

/** Lead source and concern are open vocabularies in Zoho — a new value there
 *  must not silently become null here, so it is created on first sight exactly
 *  as the importer created them. */
async function ensureLookup(
  db: SupabaseClient, table: 'lead_sources' | 'concerns', label: string, code: string,
) {
  await db.from(table).upsert(
    { code, label_en: label, sort_order: 200 }, { onConflict: 'code', ignoreDuplicates: true });
  const { data } = await db.from(table).select('id').eq('code', code).maybeSingle();
  return (data as { id: string } | null)?.id ?? null;
}

const sourceCode = (v: string) => norm(v).replace('faceebook', 'facebook');
const concernCode = (v: string) => norm(v).replace(/s$/, '');

/**
 * Pull the given Zoho record ids and write them into our tables.
 *
 * Idempotent by construction: the customer is keyed on the normalised phone,
 * the identity on (system, external_id), and the lead on zoho_record_id — so
 * the same notification delivered three times, which Zoho does, produces one
 * row and two no-ops.
 */
export async function syncZohoRecords(ids: string[]): Promise<SyncResult> {
  const result: SyncResult = { fetched: 0, created: 0, updated: 0, skipped: [] };
  if (!ids.length) return result;

  const db = serviceClient();

  // Separate the real ids first. One bad value would otherwise fail the whole
  // batch at Zoho and strand every genuine record in it.
  const usable = ids.filter(isRecordId);
  for (const id of ids) {
    if (!isRecordId(id)) result.skipped.push({ id, reason: 'not a Zoho record id' });
  }
  if (!usable.length) return result;

  const records = await fetchRecords(usable);
  result.fetched = records.length;

  for (const id of usable) {
    if (!records.some((r) => r.id === bare(id)))
      result.skipped.push({ id, reason: 'not returned by Zoho (deleted or not permitted)' });
  }
  if (!records.length) return result;

  const look = await loadLookups(db);

  for (const rec of records) {
    const recordId = zcrm(rec.id);
    const phone = toE164(str(rec.Contact_Number));
    if (!phone) {
      result.skipped.push({ id: recordId, reason: 'unparseable phone' });
      continue;
    }

    // ---- lookups this record needs, created if new -------------------------
    const rawSource = str(rec.Lead_Source);
    const sourceId = rawSource && !blank(rawSource)
      ? look.sources[sourceCode(rawSource)]
        ?? await ensureLookup(db, 'lead_sources', rawSource, sourceCode(rawSource))
      : null;

    const rawConcern = str(rec.Diseases);
    const concernId = rawConcern && !blank(rawConcern)
      ? look.concerns[concernCode(rawConcern)]
        ?? await ensureLookup(db, 'concerns', rawConcern, concernCode(rawConcern))
      : null;

    const owner = userId(str(rec.Follow_up_Done_By), look.users);
    const created = ts(str(rec.Created_Time)) ?? new Date().toISOString();

    // ---- customer ----------------------------------------------------------
    const { data: existing } = await db
      .from('customers').select('id').eq('phone_e164', phone).maybeSingle();

    let customerId = (existing as { id: string } | null)?.id ?? null;

    if (!customerId) {
      const { data: inserted, error } = await db.from('customers').insert({
        phone_e164: phone,
        phone_raw: str(rec.Contact_Number),
        alt_phone_e164: toE164(str(rec.Alternate_Number)),
        full_name: cleanName(str(rec.Name)) || 'Unknown',
        email: blank(str(rec.Email)) ? null : str(rec.Email)!.toLowerCase(),
        gender: gender(str(rec.Genderr)),
        age: age(rec.Age),
        state: blank(str(rec.State)) ? null : str(rec.State),
        address: blank(str(rec.Address)) ? null : str(rec.Address),
        primary_concern_id: concernId,
        first_source_id: sourceId,
        original_owner_id: owner,
        current_owner_id: owner,
        created_at: created,
      }).select('id').maybeSingle();

      if (error || !inserted) {
        result.skipped.push({ id: recordId, reason: `customer insert failed: ${error?.message}` });
        continue;
      }
      customerId = (inserted as { id: string }).id;
    }

    await db.from('customer_identities').upsert(
      { customer_id: customerId, system: 'zoho', external_id: recordId },
      { onConflict: 'system,external_id', ignoreDuplicates: true });

    // ---- the lead ----------------------------------------------------------
    const rawStatus = str(rec.Lead_Status1);
    const statusCode = STATUS[norm(rawStatus)];
    const statusId = statusCode ? look.statuses[statusCode] : undefined;

    const shared = {
      concern_id: concernId,
      owner_id: owner,
      utm_source: blank(str(rec.UTM_Source)) ? null : str(rec.UTM_Source),
      utm_medium: blank(str(rec.UTM_Medium)) ? null : str(rec.UTM_Medium),
      utm_campaign: blank(str(rec.UTM_Campaign)) ? null : str(rec.UTM_Campaign),
      first_contacted_at: ts(str(rec.Date_of_Calling)),
      zoho_connection_status: blank(str(rec.Lead_Status)) ? null : str(rec.Lead_Status),
      zoho_lead_insight: blank(str(rec.Lead_Insights)) ? null : str(rec.Lead_Insights),
      zoho_contacted_person: blank(str(rec.Calling_Done_By)) ? null : str(rec.Calling_Done_By),
      updated_at: new Date().toISOString(),
    };

    const { data: lead } = await db
      .from('leads').select('id, status_id').eq('zoho_record_id', recordId).maybeSingle();

    if (lead) {
      const current = lead as { id: string; status_id: string };
      const { error } = await db.from('leads').update({
        ...shared,
        // An unrecognised or blank Zoho status leaves the status ALONE. The
        // importer defaulted those to 'new', which is right when creating a
        // row and wrong when updating one: it would walk a converted lead
        // backwards every time somebody edited an unrelated field.
        ...(statusId ? { status_id: statusId } : {}),
        ...(sourceId ? { source_id: sourceId } : {}),
      }).eq('id', current.id);

      if (error) result.skipped.push({ id: recordId, reason: `lead update failed: ${error.message}` });
      else result.updated++;
    } else {
      const { error } = await db.from('leads').insert({
        customer_id: customerId,
        source_id: sourceId ?? look.sources['zoho_legacy'],
        channel: 'zoho_legacy',
        status_id: statusId ?? look.statuses['new'],
        zoho_record_id: recordId,
        created_at: created,
        ...shared,
      });

      if (error) result.skipped.push({ id: recordId, reason: `lead insert failed: ${error.message}` });
      else result.created++;
    }

    // Keep the customer's own idea of who owns them current, the way the
    // importer's final pass did.
    if (owner) await db.from('customers').update({ current_owner_id: owner }).eq('id', customerId);
  }

  return result;
}
