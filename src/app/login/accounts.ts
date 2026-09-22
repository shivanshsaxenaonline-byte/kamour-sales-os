export const LOGIN_IDS = [
  'shreyansh', 'tejasv', 'ashutosh', 'nakul',
  'nishant', 'kratika', 'shivansh', 'alka', 'anushka',
] as const;

export type LoginId = (typeof LOGIN_IDS)[number];

export const PASSWORD_REQUIRED_IDS: readonly LoginId[] = [
  'shreyansh',
  'tejasv',
  'ashutosh',
  'anushka',
  'alka',
];

export const LOGIN_PROFILES: Record<LoginId, { name: string; designation: string; tone: string }> = {
  shreyansh: { name: 'Shreyansh', designation: 'Sales', tone: 'blue' },
  tejasv: { name: 'Tejasv', designation: 'Sales', tone: 'violet' },
  ashutosh: { name: 'Ashutosh', designation: 'Sales', tone: 'cyan' },
  nakul: { name: 'Nakul', designation: 'Sales Data Operator', tone: 'orange' },
  nishant: { name: 'Nishant', designation: 'CEO', tone: 'slate' },
  kratika: { name: 'Kratika', designation: 'COO', tone: 'pink' },
  shivansh: { name: 'Shivansh', designation: 'Admin', tone: 'indigo' },
  alka: { name: 'Alka', designation: 'Audit', tone: 'teal' },
  anushka: { name: 'Anushka', designation: 'Audit', tone: 'rose' },
};

export const RRR_ONLY_IDS: readonly LoginId[] = [
  'alka',
  'nishant',
  'anushka',
];

/**
 * What an "RRR only" account may actually open, in sidebar order.
 *
 * It is no longer only RRR: Alka and Anushka hand out the WATI Interested
 * leads and Nishant reads the day, so that screen and its analytics have to be
 * reachable from accounts that are otherwise pinned to RRR. Listed as sections
 * rather than exact paths — a child page like the analytics view is part of
 * the section its parent owns.
 */
export const RRR_ONLY_SECTIONS: readonly string[] = [
  '/rrr',
  '/leads/wati-interested',
];

export function isRrrOnlySection(pathname: string) {
  return RRR_ONLY_SECTIONS.some(
    (section) => pathname === section || pathname.startsWith(`${section}/`),
  );
}

export function loginIdFromEmail(email: string | null | undefined) {
  const loginId = email?.split('@')[0]?.toLowerCase();
  return LOGIN_IDS.find((id) => id === loginId) ?? null;
}
