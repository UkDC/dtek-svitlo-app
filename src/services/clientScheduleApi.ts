import {
  GroupSchedule,
  RegionId,
  getKyivTimeContext,
  kyivDateKeyFromTimestamp,
  normalizeGroupCode,
  parseDtekFactDay,
  rolloverGroupSchedule,
  sortGroupCodes,
} from './scheduleNormalizer';
import {
  KYIV_OBLAST_SETTLEMENTS,
  KYIV_STREETS_FALLBACK,
  OBLAST_STREETS_FALLBACK,
} from './addressCatalog';

const OUTAGE_DATA_KYIV_URL =
  'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json';
const OUTAGE_DATA_REGION_URL =
  'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';

/**
 * The bot refreshes `state/combined-schedules.json` on `main` every few minutes, but the copy that ships
 * with the Pages build is frozen at the last deploy (sync commits are `[skip ci]`). Only the `main` copy
 * is fresh enough to be trusted for the «emergency» flag.
 */
const SNAPSHOT_MAIN_URL =
  'https://raw.githubusercontent.com/UkDC/dtek-svitlo-app/main/state/combined-schedules.json';

const CACHE_KEY_SCHEDULES = 'svitlo_cached_schedules_v1';

/**
 * YASNO's emergency flag lives only in the server snapshot (the live mirror does not carry it), so it is
 * copied from the snapshot onto the freshly parsed schedule — but ONLY from a fresh snapshot: a stale one
 * would keep «Екстрені відключення» on screen long after they were lifted.
 */
export function carryEmergencyFlag(
  snapshotGroup: GroupSchedule | undefined,
  fresh: GroupSchedule,
  snapshotIsFresh: boolean
): GroupSchedule {
  if (snapshotIsFresh && snapshotGroup?.today?.status === 'EmergencyShutdowns') {
    fresh.today.status = 'EmergencyShutdowns';
  }
  return fresh;
}

export interface RegionSchedulesBundle {
  kem: Record<string, GroupSchedule>;
  krem: Record<string, GroupSchedule>;
  kemGroups: string[];
  kremGroups: string[];
  fetchedAt: string;
  sourceLabel: string;
}

interface OutageDataUaJson {
  regionId?: string;
  lastUpdated?: string;
  fact?: {
    data?: Record<string, Record<string, Record<string, string>>>;
    update?: string;
    today?: number;
  };
}

export function parseOutageDataUaBundle(
  raw: OutageDataUaJson,
  region: RegionId,
  sourceName: string
): Record<string, GroupSchedule> {
  const result: Record<string, GroupSchedule> = {};
  const factData = raw?.fact?.data;
  if (!factData) return result;

  const { todayDateKey, tomorrowDateKey } = getKyivTimeContext();

  // Days are keyed by their real Kyiv calendar date, NOT by order: a mirror that still carries
  // yesterday's key (or has no entry for today yet) must never be shown as "today".
  const dayByDateKey = new Map<string, { ts: number; groups: Record<string, Record<string, string>> }>();
  for (const k of Object.keys(factData)) {
    const ts = parseInt(k, 10);
    if (isNaN(ts)) continue;
    dayByDateKey.set(kyivDateKeyFromTimestamp(ts), { ts, groups: factData[k] || {} });
  }

  const todayEntry = dayByDateKey.get(todayDateKey);
  const tomorrowEntry = dayByDateKey.get(tomorrowDateKey);
  if (!todayEntry && !tomorrowEntry) return result;

  const todayTs = todayEntry?.ts ?? 0;
  const tomorrowTs = tomorrowEntry?.ts ?? 0;
  const todayGroups = todayEntry?.groups ?? {};
  const tomorrowGroups = tomorrowEntry?.groups ?? {};

  const allRawGroupKeys = new Set([
    ...Object.keys(todayGroups),
    ...Object.keys(tomorrowGroups),
  ]);

  const updatedAt =
    raw.fact?.update || raw.lastUpdated || new Date().toLocaleTimeString('uk-UA');

  for (const rawGroupKey of allRawGroupKeys) {
    const displayGroup = normalizeGroupCode(rawGroupKey);
    if (!displayGroup) continue;

    const todayHourMap = todayGroups[rawGroupKey];
    const tomorrowHourMap = tomorrowGroups[rawGroupKey];

    const todaySchedule = parseDtekFactDay(
      todayHourMap,
      todayTs,
      todayDateKey,
      updatedAt
    );

    const tomorrowSchedule = parseDtekFactDay(
      tomorrowHourMap,
      tomorrowTs,
      tomorrowDateKey,
      updatedAt
    );

    result[displayGroup] = {
      groupKey: rawGroupKey,
      displayGroup,
      region,
      today: todaySchedule,
      tomorrow: tomorrowSchedule,
      source: sourceName,
      updatedAt,
    };
  }

  return result;
}

/**
 * Re-labels every group of a bundle against the current Kyiv date (see rolloverGroupSchedule).
 */
export function rolloverBundle(bundle: RegionSchedulesBundle): RegionSchedulesBundle {
  const { todayDateKey, tomorrowDateKey } = getKyivTimeContext();
  const roll = (m: Record<string, GroupSchedule>) => {
    const out: Record<string, GroupSchedule> = {};
    for (const [grp, sched] of Object.entries(m || {})) {
      out[grp] = rolloverGroupSchedule(sched, todayDateKey, tomorrowDateKey);
    }
    return out;
  };
  return { ...bundle, kem: roll(bundle.kem), krem: roll(bundle.krem) };
}

export function loadCachedSchedules(): RegionSchedulesBundle | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY_SCHEDULES);
    if (!raw) return null;
    return rolloverBundle(JSON.parse(raw) as RegionSchedulesBundle);
  } catch {
    return null;
  }
}

export function saveCachedSchedules(bundle: RegionSchedulesBundle): void {
  try {
    localStorage.setItem(CACHE_KEY_SCHEDULES, JSON.stringify(bundle));
  } catch {
    // Ignore storage quota errors
  }
}

export async function fetchAllSchedules(
  forceRefresh = false
): Promise<RegionSchedulesBundle> {
  try {
    const apiRes = await fetch(
      `./api/schedules${forceRefresh ? '?refresh=1' : ''}`,
      {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(4500),
      }
    );
    if (apiRes.ok) {
      const contentType = apiRes.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        const bundle = (await apiRes.json()) as RegionSchedulesBundle;
        if (bundle && bundle.kem && bundle.krem) {
          saveCachedSchedules(bundle);
          return bundle;
        }
      }
    }
  } catch {
    // Fallback to direct CORS-friendly GitHub cloud sources
  }

  const cacheBust = forceRefresh ? `?t=${Date.now()}` : `?t=${Math.floor(Date.now() / 60000)}`;
  // NOTE: do NOT add a `Cache-Control` request header here. It is not CORS-safelisted, so the browser
  // sends a preflight that raw.githubusercontent.com rejects and the "live" fetch fails silently
  // (the app then falls back to the stale repo snapshot). `cache: 'no-store'` + the `?t=` query is enough.
  const fetchOpts: RequestInit = forceRefresh ? { cache: 'no-store' } : { cache: 'default' };

  const [kyivRes, regionRes, mainSnapshotRes] = await Promise.allSettled([
    fetch(`${OUTAGE_DATA_KYIV_URL}${cacheBust}`, fetchOpts),
    fetch(`${OUTAGE_DATA_REGION_URL}${cacheBust}`, fetchOpts),
    fetch(`${SNAPSHOT_MAIN_URL}${cacheBust}`, fetchOpts),
  ]);

  let kem: Record<string, GroupSchedule> = {};
  let krem: Record<string, GroupSchedule> = {};
  const sourceParts: string[] = [];

  // Prefer the fresh snapshot from `main`; the copy baked into the Pages build is only a fallback.
  const readSnapshot = async (
    res: PromiseSettledResult<Response>
  ): Promise<RegionSchedulesBundle | null> => {
    if (res.status !== 'fulfilled' || !res.value.ok) return null;
    try {
      const snap = (await res.value.json()) as RegionSchedulesBundle;
      return snap?.kem || snap?.krem ? snap : null;
    } catch {
      return null;
    }
  };
  const mainSnap = await readSnapshot(mainSnapshotRes);
  const snapshotIsFresh = mainSnap !== null;
  // The Pages copy is requested only when `main` is unreachable (saves a few hundred KB per refresh).
  const repoSnap =
    mainSnap ??
    (await readSnapshot(
      await Promise.allSettled([fetch(`./state/combined-schedules.json${cacheBust}`, fetchOpts)]).then((r) => r[0])
    ));

  if (repoSnap) {
    const rolled = rolloverBundle({
      ...repoSnap,
      kem: repoSnap.kem || {},
      krem: repoSnap.krem || {},
    });
    kem = { ...rolled.kem };
    krem = { ...rolled.krem };
    if (repoSnap.sourceLabel) sourceParts.push(repoSnap.sourceLabel);
  }

  if (kyivRes.status === 'fulfilled' && kyivRes.value.ok) {
    const kyivJson = (await kyivRes.value.json()) as OutageDataUaJson;
    const parsedKem = parseOutageDataUaBundle(
      kyivJson,
      'kem',
      'ДТЭК Киев + YASNO'
    );
    if (Object.keys(parsedKem).length > 0) {
      for (const [grp, sched] of Object.entries(parsedKem)) {
        kem[grp] = carryEmergencyFlag(kem[grp], sched, snapshotIsFresh);
      }
      sourceParts.push('ДТЭК Киев (Live)');
    }
  }

  if (regionRes.status === 'fulfilled' && regionRes.value.ok) {
    const regionJson = (await regionRes.value.json()) as OutageDataUaJson;
    const parsedKrem = parseOutageDataUaBundle(
      regionJson,
      'krem',
      'ДТЭК Киевская обл.'
    );
    if (Object.keys(parsedKrem).length > 0) {
      krem = { ...krem, ...parsedKrem };
      sourceParts.push('ДТЭК Область (Live)');
    }
  }

  const kemGroups = sortGroupCodes(
    Object.keys(kem).length > 0
      ? Object.keys(kem)
      : ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']
  );
  const kremGroups = sortGroupCodes(
    Object.keys(krem).length > 0
      ? Object.keys(krem)
      : ['1.1', '1.2', '2.1', '2.2', '3.1', '3.2', '4.1', '4.2', '5.1', '5.2', '6.1', '6.2']
  );

  const bundle: RegionSchedulesBundle = {
    kem,
    krem,
    kemGroups,
    kremGroups,
    fetchedAt: new Date().toISOString(),
    sourceLabel:
      sourceParts.length > 0
        ? Array.from(new Set(sourceParts)).join(' • ')
        : 'Оперативное зеркало ДТЭК',
  };

  if (Object.keys(kem).length > 0 || Object.keys(krem).length > 0) {
    saveCachedSchedules(bundle);
    return bundle;
  }

  const cached = loadCachedSchedules();
  if (cached) return cached;

  return bundle;
}

export interface StreetSearchItem {
  id?: number;
  name: string;
}

export interface HouseLookupResult {
  house: string;
  group?: string;
  /** YASNO house id (Kyiv only); lets us resolve the group for exactly this house */
  id?: number;
}

/**
 * Read-only proxy to the YASNO address API (Kyiv city only). YASNO sends no CORS headers, so the
 * browser cannot call it directly (IMPLEMENTATION_PLAN.md 2.1). Source: cloudflare/address/.
 */
export const ADDRESS_API_URL: string =
  (import.meta as any).env?.VITE_ADDRESS_API_URL ||
  'https://svitlo-address.svitlo-b79d27.workers.dev';

const proxyCache = new Map<string, Promise<any>>();
function proxyGet<T = any>(pathAndQuery: string): Promise<T | null> {
  let p = proxyCache.get(pathAndQuery);
  if (!p) {
    p = fetch(`${ADDRESS_API_URL}${pathAndQuery}`, { signal: AbortSignal.timeout(6000) })
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    proxyCache.set(pathAndQuery, p);
    // never cache failures: a flaky network must not stick for the whole session
    p.then((v) => {
      if (v === null) proxyCache.delete(pathAndQuery);
    });
  }
  return p;
}

const stripStreetPrefix = (name: string) =>
  name.replace(/^(вул\.|просп\.|пров\.|бул\.|пл\.|узв\.|шосе|наб\.|пр-т)\s*/i, '').trim();

/**
 * Resolve the CURRENT YASNO street id by name. YASNO renumbers its internal ids from time to time,
 * so the id stored in kyiv-streets.json is only a hint: it is used only if YASNO still returns it
 * for this street name. A stale id would silently point to a different street.
 */
async function resolveYasnoStreetId(
  street: string,
  hintId?: number
): Promise<number | 'service' | undefined> {
  const clean = stripStreetPrefix(street);
  const tokens = normalizeSearchTokens(clean).filter((t) => t.length >= 2);
  if (tokens.length === 0) return undefined;
  const longest = [...tokens].sort((a, b) => b.length - a.length)[0];
  // YASNO lists names capitalised ("Хрещатик"); do not rely on its search being case-insensitive.
  const probe = longest.charAt(0).toUpperCase() + longest.slice(1);
  const list: Array<{ id: number; value: string }> | null = await proxyGet(
    `/streets?query=${encodeURIComponent(probe)}`
  );
  if (!list) return 'service';
  const candidates = list.filter((c) => matchesTokens(c.value, street));
  if (hintId !== undefined && candidates.some((c) => c.id === hintId)) return hintId;
  if (candidates.length === 1) return candidates[0].id;
  const exact = candidates.filter(
    (c) => stripStreetPrefix(c.value).toLowerCase() === clean.toLowerCase()
  );
  if (exact.length === 1) return exact[0].id;
  return undefined; // ambiguous -> do NOT guess
}

export type LookupFailure = 'service' | 'street' | 'house' | 'group';

const LATIN_TO_CYR: Record<string, string> = {
  a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', i: 'і', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х',
};

/** Compare house numbers tolerantly: case, spaces, backslash vs "/", Latin lookalike letters. */
export function normalizeHouseNumber(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(буд\.?|б\.)\s*/, '')
    .replace(/[\\|]/g, '/')
    .replace(/\s+/g, '')
    .replace(/[abcehikmoptx]/g, (ch) => LATIN_TO_CYR[ch] ?? ch);
}

/** Real group for a Kyiv house via YASNO. Never invents a group. */
async function lookupKyivHouseViaProxy(
  street: string,
  streetId: number | undefined,
  houseQuery: string
): Promise<{
  houses: HouseLookupResult[];
  detectedGroup?: string;
  failure?: LookupFailure;
} | null> {
  const sid = await resolveYasnoStreetId(street, streetId);
  if (sid === 'service') return null;
  if (!sid) return { houses: [], failure: 'street' };
  const fetchHouses = (q: string) =>
    proxyGet<Array<{ id: number; value: string }>>(
      `/houses?streetId=${sid}&query=${encodeURIComponent(q || '1')}`
    );
  let list = await fetchHouses(houseQuery);
  if (!list) return null;

  const wanted = normalizeHouseNumber(houseQuery);
  const findExact = (l: Array<{ id: number; value: string }>) =>
    l.filter((h) => normalizeHouseNumber(h.value) === wanted);
  let exact = wanted ? findExact(list) : [];

  // "17/3" may be stored differently by YASNO: also ask for the base number and match tolerantly.
  const base = houseQuery.trim().match(/^\d+/)?.[0];
  if (wanted && exact.length === 0 && base && base !== houseQuery.trim()) {
    const extra = await fetchHouses(base);
    if (extra) {
      const seen = new Set(list.map((h) => h.id));
      list = [...extra.filter((h) => !seen.has(h.id)), ...list];
      exact = findExact(list);
    }
  }

  const houses: HouseLookupResult[] = list.map((h) => ({ house: h.value, id: h.id }));
  if (!wanted) return { houses };
  // several different YASNO entries for one input -> ambiguous, do NOT guess
  if (exact.length !== 1) {
    return { houses, failure: exact.length === 0 ? 'house' : 'group' };
  }
  const g: { group?: number; subgroup?: number } | null = await proxyGet(
    `/group?streetId=${sid}&houseId=${exact[0].id}`
  );
  if (g?.group) return { houses, detectedGroup: `${g.group}.${g.subgroup || 1}` };
  return { houses, failure: 'group' };
}

// In-memory caches of full Kyiv streets (~3,406) & Kyiv Oblast settlements (~1,038+)
let cachedKyivStreets: StreetSearchItem[] | null = null;
let cachedOblastSettlements: string[] | null = null;
const cachedVillageStreets = new Map<string, string[]>();

export function cleanSettlementNameForSort(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(с\.|м\.|смт)\s+/i, '')
    .replace(/['’ʼ"()]/g, '')
    .trim();
}

export function cleanStreetNameForSort(name: string): string {
  return name
    .toLowerCase()
    .replace(/^(вул\.|пров\.|просп\.|бул\.|площа|набережна|алея|узвіз|тупик|шосе|проїзд)\s+/i, '')
    .replace(/['’ʼ"()]/g, '')
    .trim();
}

export function compareStreetsAlphabetically(aName: string, bName: string): number {
  const ca = cleanStreetNameForSort(aName);
  const cb = cleanStreetNameForSort(bName);
  const cyrA = /^[а-яіїєґ]/i.test(ca);
  const cyrB = /^[а-яіїєґ]/i.test(cb);
  if (cyrA !== cyrB) return cyrA ? -1 : 1;
  return ca.localeCompare(cb, 'uk');
}

async function ensureKyivStreetsLoaded(): Promise<StreetSearchItem[]> {
  if (cachedKyivStreets && cachedKyivStreets.length > 50) {
    return cachedKyivStreets;
  }
  const byName = new Map<string, StreetSearchItem>();
  try {
    const res = await fetch('./state/kyiv-streets.json');
    if (res.ok) {
      const list = (await res.json()) as StreetSearchItem[];
      if (Array.isArray(list)) {
        for (const item of list) {
          const key = item.name.toLowerCase();
          byName.set(key, item);
        }
      }
    }
  } catch {
    // ignore
  }

  for (const s of KYIV_STREETS_FALLBACK) {
    const key = s.name.toLowerCase();
    const existing = byName.get(key);
    if (!existing || (!existing.id && s.id)) {
      byName.set(key, { id: s.id, name: s.name });
    }
  }

  const all = Array.from(byName.values());
  all.sort((a, b) => compareStreetsAlphabetically(a.name, b.name));
  cachedKyivStreets = all;
  return cachedKyivStreets;
}

async function ensureOblastSettlementsLoaded(): Promise<string[]> {
  if (cachedOblastSettlements && cachedOblastSettlements.length > 50) {
    return cachedOblastSettlements;
  }
  const seen = new Set<string>();
  const combined: string[] = [];
  try {
    const res = await fetch('./state/oblast-settlements.json');
    if (res.ok) {
      const list = (await res.json()) as string[];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (!seen.has(item)) {
            seen.add(item);
            combined.push(item);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  for (const item of KYIV_OBLAST_SETTLEMENTS) {
    if (!seen.has(item)) {
      seen.add(item);
      combined.push(item);
    }
  }

  combined.sort((a, b) =>
    cleanSettlementNameForSort(a).localeCompare(cleanSettlementNameForSort(b), 'uk')
  );
  cachedOblastSettlements = combined;
  return combined;
}

/**
 * Normalizes query for Ukrainian/Russian fuzzy matching (e.g. "и" -> "і", strips "вул.", etc.)
 */
function normalizeSearchTokens(input: string): string[] {
  const cleaned = input
    .toLowerCase()
    .replace(
      /^(вул\.|вулиця|ул\.|улица|просп\.|проспект|пров\.|провулок|бул\.|бульвар|с\.|село|м\.|місто|смт)\s+/i,
      ''
    )
    .replace(/['’ʼ"]/g, '')
    .trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean);
}

function matchesTokens(target: string, rawQuery: string): boolean {
  const tLower = target.toLowerCase().replace(/['’ʼ"]/g, '');
  const qLower = rawQuery.trim().toLowerCase().replace(/['’ʼ"]/g, '');
  if (!qLower) return true;
  if (tLower.includes(qLower)) return true;

  const tokens = normalizeSearchTokens(rawQuery);
  if (tokens.length === 0) return true;

  return tokens.every((tok) => {
    if (tLower.includes(tok)) return true;
    const ukVariant = tok
      .replace(/и/g, 'і')
      .replace(/е/g, 'є')
      .replace(/ъ/g, '')
      .replace(/ы/g, 'и');
    return tLower.includes(ukVariant);
  });
}

function formatOsmRoadName(raw: string): string {
  const s = raw.trim();
  if (/ вулиця$/i.test(s)) return 'вул. ' + s.replace(/ вулиця$/i, '').trim();
  if (/^вулиця /i.test(s)) return 'вул. ' + s.replace(/^вулиця /i, '').trim();
  if (/ провулок$/i.test(s)) return 'пров. ' + s.replace(/ провулок$/i, '').trim();
  if (/^провулок /i.test(s)) return 'пров. ' + s.replace(/^провулок /i, '').trim();
  if (/ проспект$/i.test(s)) return 'просп. ' + s.replace(/ проспект$/i, '').trim();
  if (/^проспект /i.test(s)) return 'просп. ' + s.replace(/^проспект /i, '').trim();
  if (/ бульвар$/i.test(s)) return 'бул. ' + s.replace(/ бульвар$/i, '').trim();
  if (/^бульвар /i.test(s)) return 'бул. ' + s.replace(/^бульвар /i, '').trim();
  return s;
}

/**
 * Searches settlements for Kyiv Oblast (`krem`) across all 1,038+ settlements + live Nominatim CORS API
 */
export async function searchSettlements(
  region: RegionId,
  query: string
): Promise<string[]> {
  if (region === 'kem') return ['м. Київ'];

  const allLocal = await ensureOblastSettlementsLoaded();
  const q = query.trim();

  if (!q) {
    return allLocal.slice(0, 30);
  }

  const localMatches = allLocal.filter((s) => matchesTokens(s, q));

  // Prioritize settlements whose name starts with the query token, then alphabetical
  const tokens = normalizeSearchTokens(q);
  const firstTok = tokens[0] || q.toLowerCase();
  localMatches.sort((a, b) => {
    const aClean = cleanSettlementNameForSort(a);
    const bClean = cleanSettlementNameForSort(b);
    const aStarts = aClean.startsWith(firstTok) ? 0 : 1;
    const bStarts = bClean.startsWith(firstTok) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    return aClean.localeCompare(bClean, 'uk');
  });

  const topMatches = localMatches.slice(0, 30);

  // If user typed 2+ chars, also query Nominatim (CORS: *) for exact district details if needed
  if (q.length >= 2 && topMatches.length < 6) {
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=uk&countrycodes=ua&addressdetails=1&limit=10&q=${encodeURIComponent(
        `${q}, Київська область`
      )}`;
      const res = await fetch(nomUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const items = (await res.json()) as any[];
        for (const it of items) {
          const name =
            it.address?.village ||
            it.address?.town ||
            it.address?.city ||
            it.address?.hamlet ||
            it.name;
          const district = it.address?.county || it.address?.district || '';
          if (name) {
            const prefix = it.address?.city
              ? 'м. '
              : it.address?.town
              ? 'смт '
              : 'с. ';
            const label = district
              ? `${prefix}${name} (${district})`
              : `${prefix}${name}`;
            if (!topMatches.includes(label)) {
              topMatches.push(label);
            }
          }
        }
      }
    } catch {
      // ignore network error
    }
  }

  return topMatches.slice(0, 20);
}

/**
 * Fetches and caches all streets in a given Kyiv Oblast village/town via Overpass API (CORS: *)
 */
async function ensureVillageStreetsLoaded(cleanCity: string): Promise<string[]> {
  if (!cleanCity) return OBLAST_STREETS_FALLBACK;
  const cacheKey = cleanCity.toLowerCase();
  const existing = cachedVillageStreets.get(cacheKey);
  if (existing && existing.length > 0) return existing;

  const streetSet = new Set<string>();

  try {
    const safeCity = cleanCity.replace(/["\\]/g, '');
    const overpassQuery = `[out:json][timeout:8];area["ISO3166-2"="UA-32"]->.obl;area["name"="${safeCity}"](area.obl)->.v;way["highway"]["name"](area.v);out tags;`;
    const res = await fetch(
      `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(
        overpassQuery
      )}`,
      { signal: AbortSignal.timeout(4500) }
    );
    if (res.ok) {
      const data = await res.json();
      for (const el of data.elements || []) {
        const raw = el.tags?.['name:uk'] || el.tags?.name;
        if (raw) {
          streetSet.add(formatOsmRoadName(raw));
        }
      }
    }
  } catch {
    // ignore Overpass timeout
  }

  for (const fb of OBLAST_STREETS_FALLBACK) {
    streetSet.add(fb);
  }

  const list = Array.from(streetSet).sort((a, b) =>
    compareStreetsAlphabetically(a, b)
  );
  cachedVillageStreets.set(cacheKey, list);
  return list;
}

/**
 * Searches streets for Kyiv (`kem`, 3,406 streets) or Kyiv Oblast (`krem`, any village/town via Overpass/Nominatim CORS *)
 */
export async function searchStreets(
  region: RegionId,
  city: string,
  query: string
): Promise<StreetSearchItem[]> {
  const q = query.trim();

  if (region === 'kem') {
    const allStreets = await ensureKyivStreetsLoaded();
    if (!q) {
      return allStreets.slice(0, 30);
    }

    const matched = allStreets.filter((s) => matchesTokens(s.name, q));

    // Prioritize streets that start with the query token, then alphabetical
    const tokens = normalizeSearchTokens(q);
    const firstTok = tokens[0] || q.toLowerCase();
    matched.sort((a, b) => {
      const aClean = cleanStreetNameForSort(a.name);
      const bClean = cleanStreetNameForSort(b.name);
      const aStarts = aClean.startsWith(firstTok) ? 0 : 1;
      const bStarts = bClean.startsWith(firstTok) ? 0 : 1;
      if (aStarts !== bStarts) return aStarts - bStarts;
      return compareStreetsAlphabetically(a.name, b.name);
    });

    if (matched.length > 0) {
      return matched.slice(0, 30);
    }

    // Live Nominatim fallback for newly renamed Kyiv streets
    try {
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=uk&countrycodes=ua&addressdetails=1&limit=12&q=${encodeURIComponent(
        `${q}, Київ`
      )}`;
      const res = await fetch(nomUrl, { signal: AbortSignal.timeout(3500) });
      if (res.ok) {
        const data = (await res.json()) as any[];
        const seen = new Set<string>();
        const out: StreetSearchItem[] = [];
        for (const item of data) {
          const road = item.address?.road || item.name;
          if (road) {
            const formatted = formatOsmRoadName(road);
            if (!seen.has(formatted)) {
              seen.add(formatted);
              out.push({ name: formatted });
            }
          }
        }
        if (out.length > 0) {
          out.sort((a, b) => compareStreetsAlphabetically(a.name, b.name));
          return out;
        }
      }
    } catch {
      // ignore
    }

    return [];
  }

  // Kyiv Oblast (krem): search streets inside the chosen settlement (e.g. "с. Гатне")
  const cleanCity = city
    .replace(/^(м\.|с\.|смт)\s+/i, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();

  const villageStreets = await ensureVillageStreetsLoaded(cleanCity);
  const results: StreetSearchItem[] = [];
  const seenNames = new Set<string>();

  const addStreet = (rawName: string) => {
    const formatted = formatOsmRoadName(rawName);
    if (formatted && !seenNames.has(formatted.toLowerCase())) {
      if (!q || matchesTokens(formatted, q)) {
        seenNames.add(formatted.toLowerCase());
        results.push({ name: formatted });
      }
    }
  };

  for (const s of villageStreets) {
    addStreet(s);
  }

  // If user typed a specific street query and few local matches found, also check Nominatim
  if (q.length >= 2 && results.length < 5) {
    try {
      const searchQ = `${q}, ${cleanCity}, Київська область`;
      const nomUrl = `https://nominatim.openstreetmap.org/search?format=jsonv2&accept-language=uk&countrycodes=ua&addressdetails=1&limit=15&q=${encodeURIComponent(
        searchQ
      )}`;
      const res = await fetch(nomUrl, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const items = (await res.json()) as any[];
        for (const item of items) {
          const road =
            item.address?.road ||
            (item.category === 'highway' ? item.name : '');
          if (road) addStreet(road);
        }
      }
    } catch {
      // ignore
    }
  }

  results.sort((a, b) => compareStreetsAlphabetically(a.name, b.name));

  return results.slice(0, 30);
}

/**
 * House number autocomplete + group lookup.
 *
 * The group is only returned when it comes from verified catalog data. It is NEVER guessed:
 * an earlier version derived a "group" from a hash of the address, which showed a made-up
 * schedule as fact. Without verified data `detectedGroup` is undefined and the user picks the
 * group manually (check it on dtek-kem.com.ua / dtek-krem.com.ua).
 */
export async function lookupHouseGroup(
  region: RegionId,
  city: string,
  street: string,
  streetId: number | undefined,
  houseQuery: string
): Promise<{
  houses: HouseLookupResult[];
  detectedGroup?: string;
  failure?: LookupFailure;
}> {
  const hClean = houseQuery.trim();
  let failure: LookupFailure | undefined;

  // 1. Check known YASNO street catalog first (instant, 0ms latency)
  if (region === 'kem' && street.trim()) {
    const foundStreet = KYIV_STREETS_FALLBACK.find(
      (s) =>
        (streetId && s.id === streetId) ||
        s.name.toLowerCase() === street.trim().toLowerCase() ||
        s.aliases?.some((a) => a.toLowerCase() === street.trim().toLowerCase()) ||
        (street.trim().length >= 5 && matchesTokens(s.name, street))
    );
    if (foundStreet?.houses) {
      let exactGroup =
        foundStreet.houses[hClean] ||
        foundStreet.houses[hClean.toUpperCase()] ||
        foundStreet.houses[hClean.toLowerCase()];

      // Also check composite house keys, e.g. "17" in "17/19"
      if (!exactGroup && hClean) {
        for (const [h, grp] of Object.entries(foundStreet.houses)) {
          const parts = h.split(/[\s/]+/);
          if (parts.includes(hClean)) {
            exactGroup = grp;
            break;
          }
        }
      }

      const rawHouses = Object.entries(foundStreet.houses)
        .filter(([h]) => {
          if (!hClean) return true;
          return h.toLowerCase().includes(hClean.toLowerCase());
        })
        .map(([house, group]) => ({ house, group }));

      // If user typed a house number not explicitly listed, add it
      if (hClean && !rawHouses.some((x) => x.house.toLowerCase() === hClean.toLowerCase())) {
        rawHouses.unshift({ house: hClean, group: exactGroup });
      }

      // Sort houses numerically
      rawHouses.sort((a, b) => {
        if (hClean) {
          const aExact = a.house.toLowerCase() === hClean.toLowerCase() ? 0 : 1;
          const bExact = b.house.toLowerCase() === hClean.toLowerCase() ? 0 : 1;
          if (aExact !== bExact) return aExact - bExact;
          const aStarts = a.house.toLowerCase().startsWith(hClean.toLowerCase()) ? 0 : 1;
          const bStarts = b.house.toLowerCase().startsWith(hClean.toLowerCase()) ? 0 : 1;
          if (aStarts !== bStarts) return aStarts - bStarts;
        }
        return a.house.localeCompare(b.house, undefined, {
          numeric: true,
          sensitivity: 'base',
        });
      });

      if (rawHouses.length > 0) {
        return { houses: rawHouses, detectedGroup: exactGroup };
      }
    }
  }

  // 2. Kyiv city: real lookup through the YASNO proxy (house list + group of the exact house)
  if (region === 'kem' && street.trim()) {
    const real = await lookupKyivHouseViaProxy(street, streetId, hClean);
    if (real && real.houses.length > 0) return real;
    // null: the service did not answer or the street could not be pinned down unambiguously
    failure = real?.failure ?? 'service';
  }

  // 3. Fallback: plain sequential house numbers (1..80), NO group (we never guess groups)
  const baseNumbers: string[] = [];
  for (let i = 1; i <= 80; i++) {
    baseNumbers.push(String(i));
  }

  const candidateNumbers: string[] = [];
  if (hClean) {
    candidateNumbers.push(
      hClean,
      `${hClean}А`,
      `${hClean}Б`,
      `${hClean}В`,
      `${hClean}/1`,
      `${hClean}/2`
    );
  }

  for (const n of baseNumbers) {
    if (!hClean || n.startsWith(hClean) || n === hClean) {
      if (!candidateNumbers.includes(n)) candidateNumbers.push(n);
    }
  }

  const houses: HouseLookupResult[] = candidateNumbers.slice(0, 80).map((h) => ({
    house: h,
  }));

  return { houses, detectedGroup: undefined, failure };
}

