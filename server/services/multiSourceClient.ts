import fs from 'node:fs';
import path from 'node:path';
import {
  GroupSchedule,
  RegionId,
  YasnoRawDay,
  getKyivTimeContext,
  normalizeGroupCode,
  parseYasnoDay,
  sortGroupCodes,
} from '../../src/services/scheduleNormalizer.ts';
import {
  RegionSchedulesBundle,
  parseOutageDataUaBundle,
} from '../../src/services/clientScheduleApi.ts';
import {
  KYIV_STREETS_FALLBACK,
  OBLAST_STREETS_FALLBACK,
} from '../../src/services/addressCatalog.ts';

const OUTAGE_KYIV_URL =
  'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json';
const OUTAGE_REGION_URL =
  'https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv-region.json';

const YASNO_BASE =
  'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902';

const USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.7 Mobile/15E148 Safari/604.1';

interface YasnoGroupEntry {
  today?: YasnoRawDay;
  tomorrow?: YasnoRawDay;
  updatedOn?: string;
}

let cachedBundle: RegionSchedulesBundle | null = null;
let lastFetchTimestamp = 0;

/**
 * Fetches YASNO API v2 planned-outages for Kyiv (region 25, dso 902)
 */
export async function fetchYasnoKyivSchedules(): Promise<Record<string, GroupSchedule>> {
  const result: Record<string, GroupSchedule> = {};
  try {
    const res = await fetch(`${YASNO_BASE}/planned-outages`, {
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return result;

    const raw = (await res.json()) as Record<string, YasnoGroupEntry>;
    const { todayDateKey, tomorrowDateKey } = getKyivTimeContext();

    for (const [rawKey, entry] of Object.entries(raw)) {
      const displayGroup = normalizeGroupCode(rawKey);
      if (!displayGroup || !entry) continue;

      const updatedAt = entry.updatedOn
        ? new Date(entry.updatedOn).toLocaleString('uk-UA', {
            timeZone: 'Europe/Kyiv',
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })
        : new Date().toLocaleTimeString('uk-UA');

      const today = parseYasnoDay(entry.today, todayDateKey, updatedAt);
      const tomorrow = parseYasnoDay(entry.tomorrow, tomorrowDateKey, updatedAt);

      result[displayGroup] = {
        groupKey: `GPV${displayGroup}`,
        displayGroup,
        region: 'kem',
        today,
        tomorrow,
        source: 'YASNO API v2 + ДТЭК Киев',
        updatedAt,
      };
    }
  } catch (err) {
    // Non-fatal: fallback to Outage-Data-UA mirror
  }
  return result;
}

/**
 * Aggregates all 3 operational sources (Outage-Data-UA + YASNO API v2 + DTEK)
 * into a unified RegionSchedulesBundle and saves it to state/combined-schedules.json
 */
export async function fetchMultiSourceSchedules(
  forceRefresh = false
): Promise<RegionSchedulesBundle> {
  const now = Date.now();
  if (!forceRefresh && cachedBundle && now - lastFetchTimestamp < 60_000) {
    return cachedBundle;
  }

  const [kyivMirrorRes, regionMirrorRes, yasnoKemMap] = await Promise.all([
    fetch(`${OUTAGE_KYIV_URL}?t=${now}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null),
    fetch(`${OUTAGE_REGION_URL}?t=${now}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(8000),
    }).catch(() => null),
    fetchYasnoKyivSchedules(),
  ]);

  let kem: Record<string, GroupSchedule> = {};
  let krem: Record<string, GroupSchedule> = {};
  const activeSources: string[] = [];

  if (kyivMirrorRes && kyivMirrorRes.ok) {
    try {
      const json = await kyivMirrorRes.json();
      kem = parseOutageDataUaBundle(json, 'kem', 'ДТЭК Киев (Outage-Data)');
      if (Object.keys(kem).length > 0) {
        activeSources.push('Outage-Data Киев');
      }
    } catch {
      // ignore
    }
  }

  // Merge YASNO API v2 schedules & emergency flags for Kyiv
  if (Object.keys(yasnoKemMap).length > 0) {
    activeSources.push('YASNO API v2');
    for (const [grp, yasnoSched] of Object.entries(yasnoKemMap)) {
      const mirrorSched = kem[grp];
      if (!mirrorSched) {
        kem[grp] = yasnoSched;
      } else {
        // Cross-verify: if YASNO reports EmergencyShutdowns or has newer intraday slots, apply it
        if (yasnoSched.today.status === 'EmergencyShutdowns') {
          mirrorSched.today.status = 'EmergencyShutdowns';
        }
        // If mirror had WaitingForSchedule for tomorrow and YASNO has ScheduleApplies, take YASNO
        if (
          mirrorSched.tomorrow.status === 'WaitingForSchedule' &&
          yasnoSched.tomorrow.status === 'ScheduleApplies'
        ) {
          mirrorSched.tomorrow = yasnoSched.tomorrow;
        }
        mirrorSched.source = 'ДТЭК Киев + YASNO API v2';
      }
    }
  }

  if (regionMirrorRes && regionMirrorRes.ok) {
    try {
      const json = await regionMirrorRes.json();
      krem = parseOutageDataUaBundle(json, 'krem', 'ДТЭК Киевская обл.');
      if (Object.keys(krem).length > 0) {
        activeSources.push('Outage-Data Область');
      }
    } catch {
      // ignore
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
      activeSources.length > 0
        ? activeSources.join(' + ')
        : 'Резервный кэш ДТЭК',
  };

  if (Object.keys(kem).length > 0 || Object.keys(krem).length > 0) {
    cachedBundle = bundle;
    lastFetchTimestamp = now;
    try {
      const stateDir = path.resolve(process.cwd(), 'state');
      const publicStateDir = path.resolve(process.cwd(), 'public/state');
      fs.mkdirSync(stateDir, { recursive: true });
      fs.mkdirSync(publicStateDir, { recursive: true });
      const payload = JSON.stringify(bundle, null, 2);
      // Skip the write when only `fetchedAt` differs, so the bot does not commit identical data every run.
      const stripTs = (json: string) => json.replace(/"fetchedAt":\s*"[^"]*"/, '"fetchedAt": ""');
      for (const dir of [stateDir, publicStateDir]) {
        const file = path.join(dir, 'combined-schedules.json');
        let unchanged = false;
        try {
          unchanged =
            fs.existsSync(file) &&
            stripTs(fs.readFileSync(file, 'utf-8')) === stripTs(payload);
        } catch {
          // ignore -> rewrite
        }
        if (!unchanged) fs.writeFileSync(file, payload);
      }
    } catch {
      // Non-fatal
    }
  }

  return bundle;
}

/**
 * Live street search via YASNO API v2 (for Kyiv) or DTEK AJAX / fallback catalog
 */
export async function searchStreetsServer(
  region: RegionId,
  city: string,
  query: string
): Promise<Array<{ id?: number; name: string }>> {
  const q = query.trim();
  const yasnoAddrBase =
    'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2';
  if (region === 'kem' && q.length >= 2) {
    try {
      const res = await fetch(
        `${yasnoAddrBase}/streets?regionId=25&dsoId=902&query=${encodeURIComponent(q)}`,
        {
          headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
          signal: AbortSignal.timeout(5000),
        }
      );
      if (res.ok) {
        const list = (await res.json()) as Array<{ id: number; value: string }>;
        if (Array.isArray(list) && list.length > 0) {
          return list.slice(0, 20).map((item) => ({
            id: item.id,
            name: item.value,
          }));
        }
      }
    } catch {
      // fallback below
    }
  }

  const qLower = q.toLowerCase();
  if (region === 'kem') {
    return KYIV_STREETS_FALLBACK.filter((s) =>
      s.name.toLowerCase().includes(qLower)
    ).map((s) => ({ id: s.id, name: s.name }));
  }

  return OBLAST_STREETS_FALLBACK.filter((s) =>
    s.toLowerCase().includes(qLower)
  ).map((name) => ({ name }));
}

/**
 * Live house search & automatic DTEK group resolution via YASNO API v2 (for Kyiv) + fallback
 */
export async function lookupHouseGroupServer(
  region: RegionId,
  _city: string,
  street: string,
  streetId: number | undefined,
  houseQuery: string
): Promise<{
  houses: Array<{ id?: number; house: string; group?: string }>;
  detectedGroup?: string;
}> {
  const yasnoAddrBase =
    'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2';
  if (region === 'kem') {
    let resolvedStreetId = streetId;
    if (!resolvedStreetId && street.trim().length >= 2) {
      const cleanName = street
        .replace(/^(вул\.|просп\.|пров\.|бул\.)\s*/i, '')
        .trim();
      const streets = await searchStreetsServer('kem', 'м. Київ', cleanName);
      if (streets.length > 0 && streets[0].id) {
        resolvedStreetId = streets[0].id;
      }
    }

    if (resolvedStreetId) {
      try {
        const q = houseQuery.trim() || '1';
        const housesRes = await fetch(
          `${yasnoAddrBase}/houses?regionId=25&dsoId=902&streetId=${resolvedStreetId}&query=${encodeURIComponent(
            q
          )}`,
          {
            headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
            signal: AbortSignal.timeout(5000),
          }
        );

        if (housesRes.ok) {
          const rawHouses = (await housesRes.json()) as Array<{
            id: number;
            value: string;
          }>;

          const topHouses = rawHouses.slice(0, 12);
          let detectedGroup: string | undefined;

          // Match exact house or first house to resolve group
          const exactMatch =
            topHouses.find(
              (h) => h.value.toLowerCase() === houseQuery.trim().toLowerCase()
            ) || topHouses[0];

          if (exactMatch) {
            const grpRes = await fetch(
              `${yasnoAddrBase}/group?regionId=25&dsoId=902&streetId=${resolvedStreetId}&houseId=${exactMatch.id}`,
              {
                headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
                signal: AbortSignal.timeout(4000),
              }
            );
            if (grpRes.ok) {
              const grpData = (await grpRes.json()) as {
                group?: number;
                subgroup?: number;
              };
              if (grpData?.group) {
                detectedGroup = `${grpData.group}.${grpData.subgroup || 1}`;
              }
            }
          }

          return {
            houses: topHouses.map((h) => ({
              id: h.id,
              house: h.value,
              group:
                exactMatch && h.id === exactMatch.id ? detectedGroup : undefined,
            })),
            detectedGroup,
          };
        }
      } catch {
        // Fallback below
      }
    }

    const fallbackStreet = KYIV_STREETS_FALLBACK.find(
      (s) =>
        (streetId && s.id === streetId) ||
        s.name.toLowerCase().includes(street.trim().toLowerCase())
    );
    if (fallbackStreet?.houses) {
      const hClean = houseQuery.trim();
      return {
        houses: Object.entries(fallbackStreet.houses).map(([house, group]) => ({
          house,
          group,
        })),
        detectedGroup: fallbackStreet.houses[hClean],
      };
    }
  }

  return { houses: [] };
}
