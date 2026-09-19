import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SHEET_ID = '1TVYa2UMtK8JIAinIBfhIlo_AkaOUlYZHtkJqzj7Fwos';
const TAB_NAME = 'Consultation Record - AP+TA+SS';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=0`;

type JsonObject = Record<string, unknown>;

export type PocSyncResult = {
  ok: true;
  locked?: boolean;
  rowsSeen: number;
  rowsActive: number;
  finishedAt?: string;
};

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('POC sync is not configured.');
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += character;
    } else if (character === '"') quoted = true;
    else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n') {
      row.push(field.replace(/\r$/, ''));
      rows.push(row);
      row = [];
      field = '';
    } else field += character;
  }
  if (field || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function clean(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed !== '-' && trimmed !== '.' ? trimmed : null;
}

function normalized(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isValue(value: string | undefined, expected: string) {
  return normalized(clean(value)) === expected;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const numeric = value.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  const names: Record<string, number> = {
    jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
    apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
    aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10, october: 10,
    nov: 11, november: 11, dec: 12, december: 12,
  };
  const named = value.match(/\b([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})\b/);
  if (!numeric && !named) return null;
  const day = Number(numeric?.[1] ?? named?.[2]);
  const month = numeric ? Number(numeric[2]) : (names[(named?.[1] ?? '').toLowerCase()] ?? 0);
  let year = Number(numeric?.[3] ?? named?.[3]);
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function phoneE164(raw: string | null): string | null {
  if (!raw) return null;
  for (const part of raw.split(/\/\/|[,/\n]/)) {
    let digits = part.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  }
  return null;
}

function safeAge(raw: string | null): number | null {
  const value = Number(raw?.match(/\d+/)?.[0]);
  return Number.isInteger(value) && value > 0 && value <= 120 ? value : null;
}

function ownerId(value: string | null, users: Map<string, string>) {
  const key = normalized(value).replace('sheryansh', 'shreyansh');
  if (!key) return null;
  if (users.has(key)) return users.get(key) ?? null;
  for (const [name, id] of users) if (key.includes(name) || name.includes(key)) return id;
  return null;
}

function indexHeaders(headers: string[]) {
  return new Map(headers.map((header, index) => [normalized(header), index]));
}

function valueAt(values: string[], indexes: Map<string, number>, header: string) {
  const index = indexes.get(normalized(header));
  return index == null ? undefined : values[index];
}

function parseRows(csv: string, users: Map<string, string>) {
  const matrix = parseCsv(csv.replace(/^\uFEFF/, ''));
  const headers = matrix[0]?.map(header => header.trim()) ?? [];
  const indexes = indexHeaders(headers);
  const occurrences = new Map<string, number>();
  const rows: JsonObject[] = [];

  matrix.slice(1).forEach((values, index) => {
    if (!isValue(valueAt(values, indexes, 'Prescription designed & medicine prescribed'), 'yes')) return;
    if (!isValue(valueAt(values, indexes, 'Med Purchased'), 'no')) return;

    const sourceRowNumber = index + 2;
    const recordNo = clean(valueAt(values, indexes, '#NAME?'));
    const customerName = clean(valueAt(values, indexes, 'Customer Name'));
    const rawPhone = clean(valueAt(values, indexes, 'Number'));
    if (!customerName && !rawPhone) return;
    const consultationDate = isoDate(clean(valueAt(values, indexes, 'Consultation Date')));
    const paymentDate = isoDate(clean(valueAt(values, indexes, 'Payment Date')));
    const joinedBy = clean(valueAt(values, indexes, 'Joined By'));
    const takenBy = clean(valueAt(values, indexes, 'Consultation Taken By Sales Team'));
    const followups = ['1st Followup', '2nd Followup', '3rd Followup', '4th Followup', '5th Followup'].map((header, attemptIndex) => {
      const raw = clean(valueAt(values, indexes, header));
      return { attempt: attemptIndex + 1, raw, occurredOn: isoDate(raw) };
    });
    const completed = followups.filter(item => item.raw);
    const dated = completed.filter(item => item.occurredOn).sort((left, right) => (right.occurredOn ?? '').localeCompare(left.occurredOn ?? ''));
    const snapshot = Object.fromEntries(headers.map((header, column) => [header || `Column ${column + 1}`, (values[column] ?? '').trim()]));
    const normalizedPhone = phoneE164(rawPhone);
    const identityBase = [recordNo, normalizedPhone ?? normalized(rawPhone), consultationDate, normalized(customerName)].join('|');
    const occurrence = (occurrences.get(identityBase) ?? 0) + 1;
    occurrences.set(identityBase, occurrence);

    rows.push({
      source_sheet_id: SHEET_ID,
      source_tab: TAB_NAME,
      source_row_number: sourceRowNumber,
      source_identity: `${identityBase}|${occurrence}`,
      record_no: recordNo,
      payment_date: paymentDate,
      consultation_date: consultationDate,
      customer_name: customerName ?? 'Unknown customer',
      phone_raw: rawPhone,
      phone_e164: normalizedPhone,
      consultation_status: clean(valueAt(values, indexes, 'Consultation Status')),
      doctor_name: clean(valueAt(values, indexes, 'Doctor Name')),
      consultation_taken_by: takenBy,
      prescription_status: clean(valueAt(values, indexes, 'Prescription designed & medicine prescribed')) ?? 'Yes',
      customer_type: clean(valueAt(values, indexes, 'Old/New')),
      age: safeAge(clean(valueAt(values, indexes, 'Age'))),
      profession: clean(valueAt(values, indexes, 'Profession')),
      state: clean(valueAt(values, indexes, 'State')),
      concern: clean(valueAt(values, indexes, 'Ad')),
      medicine_remark: clean(valueAt(values, indexes, 'Medicine Remark (Immediately After Consultation)')),
      conversion_type: clean(valueAt(values, indexes, 'Conversion Type')),
      amount: clean(valueAt(values, indexes, 'Amount')),
      payment_method: clean(valueAt(values, indexes, 'Payment')),
      lead_source: clean(valueAt(values, indexes, 'Lead Source')),
      joined_by: joinedBy,
      consultation_mode: clean(valueAt(values, indexes, 'Mode of Consultation')),
      cart_link: clean(valueAt(values, indexes, 'Cart Link')),
      cart_value: clean(valueAt(values, indexes, 'Cart Value')),
      medicine_purchased: clean(valueAt(values, indexes, 'Med Purchased')) ?? 'No',
      saved_in_crm_by: clean(valueAt(values, indexes, 'Saved in CRM by')),
      medicine_nature_status: clean(valueAt(values, indexes, 'MEDICINE NATURE STATUS')),
      followups,
      followup_count: completed.length,
      last_followup_on: dated[0]?.occurredOn ?? null,
      last_followup_summary: completed.at(-1)?.raw ?? null,
      owner_id: ownerId(joinedBy ?? takenBy, users),
      source_snapshot: snapshot,
      is_active: true,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  return { rows, rowsSeen: Math.max(matrix.length - 1, 0) };
}

async function updateState(db: SupabaseClient, patch: JsonObject) {
  await db.from('poc_sheet_sync_state').update(patch).eq('sheet_id', SHEET_ID).eq('tab_name', TAB_NAME);
}

export async function syncPocConsultationSheet(): Promise<PocSyncResult> {
  const db = serviceClient();
  const { data: claimed, error: claimError } = await db.rpc('claim_poc_sheet_sync', {
    p_sheet_id: SHEET_ID,
    p_tab_name: TAB_NAME,
  });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return { ok: true, locked: true, rowsSeen: 0, rowsActive: 0 };

  try {
    const response = await fetch(CSV_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`POC sheet returned ${response.status}.`);
    const { data: people, error: peopleError } = await db.from('users').select('id,full_name').eq('is_active', true).in('role', ['sales_exec', 'sales_manager']).range(0, 199);
    if (peopleError) throw new Error(peopleError.message);
    const users = new Map((people ?? []).map(person => [normalized(person.full_name), person.id]));
    const { rows, rowsSeen } = parseRows(await response.text(), users);
    const identities = new Set(rows.map(row => row.source_identity as string));

    for (let index = 0; index < rows.length; index += 100) {
      const { error } = await db.from('poc_leads').upsert(rows.slice(index, index + 100), {
        onConflict: 'source_sheet_id,source_tab,source_identity',
      });
      if (error) throw new Error(error.message);
    }

    const { data: existing, error: existingError } = await db
      .from('poc_leads')
      .select('id,source_identity')
      .eq('source_sheet_id', SHEET_ID)
      .eq('source_tab', TAB_NAME)
      .eq('is_active', true)
      .range(0, 1999);
    if (existingError) throw new Error(existingError.message);
    const removedIds = (existing ?? []).filter(row => !identities.has(row.source_identity)).map(row => row.id);
    for (let index = 0; index < removedIds.length; index += 100) {
      const { error } = await db.from('poc_leads').update({ is_active: false, updated_at: new Date().toISOString() }).in('id', removedIds.slice(index, index + 100));
      if (error) throw new Error(error.message);
    }

    const finishedAt = new Date().toISOString();
    await updateState(db, {
      last_finished_at: finishedAt,
      last_success_at: finishedAt,
      lock_until: null,
      rows_seen: rowsSeen,
      rows_active: rows.length,
      last_error: null,
    });
    return { ok: true, rowsSeen, rowsActive: rows.length, finishedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await updateState(db, {
      last_finished_at: new Date().toISOString(),
      lock_until: null,
      last_error: message.slice(0, 2000),
    });
    throw error;
  }
}
