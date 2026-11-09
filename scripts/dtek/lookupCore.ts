/**
 * Pure helpers for the DTEK Kyiv-oblast (krem) group lookup. No I/O and no dependencies, so that
 * the Actions runner can execute it with plain `node` (type stripping) and vitest can import it.
 *
 * Contract: NEVER guess. Any ambiguity or unexpected format ends in a structured failure reason,
 * so the app can say "could not determine" instead of showing somebody else's schedule.
 */

export const LOOKUP_REASONS = [
  'city_not_found',
  'city_ambiguous',
  'street_not_found',
  'street_ambiguous',
  'house_not_found',
  'group_unknown',
  'group_ambiguous',
  'blocked',
  'parse',
] as const;
export type LookupReason = (typeof LOOKUP_REASONS)[number];

export type LookupResult =
  | { ok: true; group: string }
  | { ok: false; reason: LookupReason; candidates?: string[] };

export const MAX_CANDIDATES = 8;

/** Groups that exist for DTEK Kyiv oblast: 1.1 … 6.2 */
export const isKremGroup = (g: string): boolean => /^[1-6]\.[12]$/.test(g);

// ---------------------------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------------------------

/** Imperva / error stubs are tiny; the real page is >1 MB. */
export function looksLikeRealPage(status: number, bytes: number): boolean {
  return status === 200 && bytes >= 20000;
}

export function extractCsrf(html: string): string | undefined {
  return html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/i)?.[1];
}

/** Extracts the balanced JSON value that follows `DisconSchedule.<name> = `. */
export function extractAssignedJson(html: string, name: string): unknown {
  const re = new RegExp(`DisconSchedule\\.${name}\\s*=\\s*`);
  const m = re.exec(html);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  const first = html[start];
  if (first !== '{' && first !== '[') return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}

/** city name (as DTEK writes it) -> list of street names. */
export type StreetsMap = Record<string, string[]>;

export function extractStreetsMap(html: string): StreetsMap | undefined {
  const raw = extractAssignedJson(html, 'streets');
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const out: StreetsMap = {};
  for (const [city, streets] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(streets)) continue;
    out[city] = streets.filter((s): s is string => typeof s === 'string');
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// ---------------------------------------------------------------------------------------------
// Name matching (city / street)
// ---------------------------------------------------------------------------------------------

const APOSTROPHES = /[’ʼ`´′‘]/g;

const SETTLEMENT_TYPES = new Set([
  'м', 'місто', 'с', 'село', 'смт', 'селище', 'сел', 'с-ще', 'сщ',
]);
const STREET_TYPES: Record<string, string> = {
  вул: 'вул', вулиця: 'вул',
  пров: 'пров', провулок: 'пров',
  просп: 'просп', проспект: 'просп', 'пр-т': 'просп', 'пр-кт': 'просп',
  бул: 'бул', бульвар: 'бул',
  пл: 'пл', площа: 'пл',
  узв: 'узв', узвіз: 'узв',
  наб: 'наб', набережна: 'наб',
  шосе: 'шосе',
  туп: 'туп', тупик: 'туп',
  проїзд: 'проїзд', 'пр-д': 'проїзд',
  алея: 'алея',
  дорога: 'дорога',
};

function words(name: string): string[] {
  return name
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(/\([^)]*\)/g, ' ') // "(Бучанський р-н)" style qualifiers
    .replace(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

export interface ParsedName {
  /** canonical type ("вул", "м", "с", …) or '' */
  type: string;
  /** name words without the type, order-insensitive key */
  core: string;
}

export function parseSettlement(name: string): ParsedName {
  const w = words(name);
  const idx = w.findIndex((x) => SETTLEMENT_TYPES.has(x));
  const type = idx >= 0 ? w[idx] : '';
  const rest = w.filter((_, i) => i !== idx);
  const canon = type === 'місто' ? 'м' : type === 'село' ? 'с' : type === 'селище' ? 'смт' : type;
  return { type: canon, core: rest.join(' ') };
}

export function parseStreet(name: string): ParsedName {
  const w = words(name);
  let type = '';
  const rest: string[] = [];
  for (const x of w) {
    if (!type && STREET_TYPES[x]) type = STREET_TYPES[x];
    else rest.push(x);
  }
  return { type, core: [...rest].sort().join(' ') };
}

export type Pick =
  | { kind: 'ok'; value: string }
  | { kind: 'none' }
  | { kind: 'ambiguous'; candidates: string[] };

function pick(
  all: string[],
  parse: (n: string) => ParsedName,
  query: string
): Pick {
  const q = parse(query);
  if (!q.core) return { kind: 'none' };
  let hits = all.filter((n) => parse(n).core === q.core);
  if (hits.length === 0) return { kind: 'none' };
  if (hits.length > 1 && q.type) {
    const typed = hits.filter((n) => parse(n).type === q.type);
    if (typed.length > 0) hits = typed;
  }
  if (hits.length === 1) return { kind: 'ok', value: hits[0] };
  return { kind: 'ambiguous', candidates: hits.slice(0, MAX_CANDIDATES) };
}

export const findCity = (map: StreetsMap, city: string): Pick =>
  pick(Object.keys(map), parseSettlement, city);

export const findStreet = (streets: string[], street: string): Pick =>
  pick(streets, parseStreet, street);

// ---------------------------------------------------------------------------------------------
// House matching
// ---------------------------------------------------------------------------------------------

const LATIN_TO_CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х',
};

/** Case, spaces, "-" before a letter, "\" vs "/", Latin lookalikes ("5-А" == "5а" == "5A"). */
export function normalizeHouse(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/^(буд\.?|б\.)\s*/, '')
    .replace(/[\\|]/g, '/')
    .replace(/\s+/g, '')
    .replace(/(\d)-(?=\p{L})/gu, '$1')
    .replace(/[abcehikmoptx]/g, (ch) => LATIN_TO_CYR[ch] ?? ch);
}

export interface HouseEntry {
  sub_type_reason?: unknown;
}
export type HousesMap = Record<string, HouseEntry>;

/** One group from the entry's reasons ("GPV5.2" -> "5.2"); non-GPV reasons (emergencies) are ignored. */
export function groupsOfEntry(entry: HouseEntry | undefined): string[] {
  const r = entry?.sub_type_reason;
  if (!Array.isArray(r)) return [];
  const set = new Set<string>();
  for (const x of r) {
    const m = typeof x === 'string' ? /^GPV(\d)\.(\d)$/i.exec(x.trim()) : null;
    if (m && isKremGroup(`${m[1]}.${m[2]}`)) set.add(`${m[1]}.${m[2]}`);
  }
  return [...set];
}

export type HouseResult =
  | { ok: true; group: string }
  | { ok: false; reason: 'house_not_found' | 'group_unknown' | 'group_ambiguous' };

/**
 * Exact (normalised) key first. Otherwise keys that are the typed number plus a "/…" part
 * ("12" vs "12/кв.3"): accepted only when ALL of them agree on one group. "12" never matches "12А":
 * that is a different building.
 */
export function resolveHouse(houses: HousesMap, house: string): HouseResult {
  const q = normalizeHouse(house);
  if (!q) return { ok: false, reason: 'house_not_found' };
  const entries = Object.entries(houses).map(([k, v]) => ({ key: normalizeHouse(k), v }));
  let hits = entries.filter((e) => e.key === q);
  if (hits.length === 0) hits = entries.filter((e) => e.key.startsWith(q + '/'));
  if (hits.length === 0) return { ok: false, reason: 'house_not_found' };
  const groups = new Set<string>();
  let unknown = false;
  for (const h of hits) {
    const g = groupsOfEntry(h.v);
    if (g.length === 0) unknown = true;
    g.forEach((x) => groups.add(x));
  }
  if (groups.size === 1 && !unknown) return { ok: true, group: [...groups][0] };
  if (groups.size === 0) return { ok: false, reason: 'group_unknown' };
  return { ok: false, reason: 'group_ambiguous' };
}

/** `data` of a getHomeNum answer. */
export function housesOf(answer: unknown): HousesMap | undefined {
  const d = (answer as { data?: unknown } | null)?.data;
  return d && typeof d === 'object' && !Array.isArray(d) ? (d as HousesMap) : undefined;
}
