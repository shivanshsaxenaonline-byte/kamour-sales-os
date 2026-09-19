import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SHEET_ID = '1Mm_jpa6z3xN7uGxHzk5hM_f9hXd47b6g9pKp9vDQxdk';
const TAB_NAME = 'PCR Calling';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=647565112`;
const FOLLOWUP_OFFSETS = [1, 2, 3, 4, 6] as const;

type JsonObject = Record<string, unknown>;

export type PcrSyncResult = {
  ok: true;
  locked?: boolean;
  rowsSeen: number;
  rowsActive: number;
  finishedAt?: string;
};

function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('PCR sync is not configured.');
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
  return trimmed && trimmed !== '-' ? trimmed : null;
}

function isoDate(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  const monthNames: Record<string, number> = {
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
  };
  const named = value.match(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4})\b/i);
  if (!match && !named) return null;
  const day = Number(match?.[1] ?? named?.[2]);
  const month = match ? Number(match[2]) : (monthNames[(named?.[1] ?? '').toLowerCase()] ?? 0);
  let year = Number(match?.[3] ?? named?.[3]);
  if (year < 100) year += 2000;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function todayInIndia(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(item => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

function phoneE164(raw: string | null): string | null {
  if (!raw) return null;
  for (const part of raw.split(/\/\/|[,/\n]/)) {
    let digits = part.replace(/\D/g, '');
    if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
    if (/^[6-9]\d{9}$/.test(digits)) return `+91${digits}`;
  }
  const match = raw.replace(/\D/g, '').match(/[6-9]\d{9}/);
  return match ? `+91${match[0]}` : null;
}

function normalize(value: string | null): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function handledBy(raw: string): string | null {
  const match = raw.match(/ashutosh|shreyansh|sheryansh|tejasv|alka|kratika|caller\s*\d*/i);
  if (!match) return null;
  const name = match[0].replace(/sheryansh/i, 'Shreyansh');
  return name.replace(/\b\w/g, character => character.toUpperCase());
}

function parseRows(csv: string) {
  const matrix = parseCsv(csv.replace(/^\uFEFF/, ''));
  const headers = matrix[0]?.map(header => header.trim()) ?? [];
  const today = todayInIndia();
  const occurrences = new Map<string, number>();
  const rows: JsonObject[] = [];
  let convertedSection = false;

  matrix.slice(1).forEach((values, index) => {
    const sourceRowNumber = index + 2;
    const bookingRaw = clean(values[0]);
    if (/^converted$/i.test(bookingRaw ?? '')) {
      convertedSection = true;
      return;
    }

    const customerName = clean(values[1]);
    const rawPhone = clean(values[2]);
    if (!customerName && !rawPhone) return;

    const bookingDate = isoDate(bookingRaw);
    const normalizedPhone = phoneE164(rawPhone);
    const followups = values.slice(3, 8).map((value, attemptIndex) => {
      const raw = value.trim();
      return {
        attempt: attemptIndex + 1,
        raw: raw || null,
        occurredOn: isoDate(raw || null),
        handledBy: raw ? handledBy(raw) : null,
      };
    });
    const completed = followups.filter(item => item.raw);
    const dated = completed.filter(item => item.occurredOn);
    const lastDated = [...dated].sort((left, right) => (right.occurredOn ?? '').localeCompare(left.occurredOn ?? ''))[0];
    const lastCompleted = completed.at(-1);
    const nextIndex = followups.findIndex(item => !item.raw);
    const nextAttempt = nextIndex >= 0 ? nextIndex + 1 : null;
    const nextFollowupOn = bookingDate && nextIndex >= 0
      ? addDays(bookingDate, FOLLOWUP_OFFSETS[nextIndex] ?? 1)
      : null;
    const priorityRank = convertedSection
      ? 4
      : nextAttempt == null
        ? 3
        : nextFollowupOn == null
          ? 2
          : nextFollowupOn <= today
            ? 0
            : 1;
    const sourceSnapshot = Object.fromEntries(headers.map((header, column) => [header, (values[column] ?? '').trim()]));
    const identityBase = [normalizedPhone ?? normalize(rawPhone), bookingDate ?? normalize(bookingRaw), normalize(customerName)].join('|');
    const occurrence = (occurrences.get(identityBase) ?? 0) + 1;
    occurrences.set(identityBase, occurrence);

    rows.push({
      source_sheet_id: SHEET_ID,
      source_tab: TAB_NAME,
      source_row_number: sourceRowNumber,
      source_identity: `${identityBase}|${occurrence}`,
      booking_date: bookingDate,
      customer_name: customerName ?? 'Unknown customer',
      phone_raw: rawPhone,
      phone_e164: normalizedPhone,
      followups,
      followup_count: completed.length,
      last_followup_on: lastDated?.occurredOn ?? null,
      last_followup_summary: lastCompleted?.raw ?? null,
      next_followup_on: nextFollowupOn,
      next_followup_attempt: nextAttempt,
      priority_rank: priorityRank,
      text_message_date: clean(values[8]),
      text_message_status: clean(values[9]),
      converted: convertedSection,
      is_active: true,
      source_snapshot: sourceSnapshot,
      last_synced_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  return { rows, rowsSeen: Math.max(matrix.length - 1, 0) };
}

async function updateState(db: SupabaseClient, patch: JsonObject) {
  await db.from('pcr_sheet_sync_state').update(patch).eq('sheet_id', SHEET_ID).eq('tab_name', TAB_NAME);
}

export async function syncPcrCallingSheet(): Promise<PcrSyncResult> {
  const db = serviceClient();
  const { data: claimed, error: claimError } = await db.rpc('claim_pcr_sheet_sync', {
    p_sheet_id: SHEET_ID,
    p_tab_name: TAB_NAME,
  });
  if (claimError) throw new Error(claimError.message);
  if (!claimed) return { ok: true, locked: true, rowsSeen: 0, rowsActive: 0 };

  try {
    const response = await fetch(CSV_URL, { cache: 'no-store' });
    if (!response.ok) throw new Error(`PCR sheet returned ${response.status}.`);
    const { rows, rowsSeen } = parseRows(await response.text());
    const identities = new Set(rows.map(row => row.source_identity as string));

    for (let index = 0; index < rows.length; index += 150) {
      const { error } = await db.from('pcr_leads').upsert(rows.slice(index, index + 150), {
        onConflict: 'source_sheet_id,source_tab,source_identity',
      });
      if (error) throw new Error(error.message);
    }

    const { data: existing, error: existingError } = await db
      .from('pcr_leads')
      .select('id,source_identity')
      .eq('source_sheet_id', SHEET_ID)
      .eq('source_tab', TAB_NAME)
      .eq('is_active', true)
      .range(0, 1999);
    if (existingError) throw new Error(existingError.message);
    const removedIds = (existing ?? []).filter(row => !identities.has(row.source_identity)).map(row => row.id);
    for (let index = 0; index < removedIds.length; index += 150) {
      const { error } = await db.from('pcr_leads').update({ is_active: false, updated_at: new Date().toISOString() }).in('id', removedIds.slice(index, index + 150));
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
