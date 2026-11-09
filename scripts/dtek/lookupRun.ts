/**
 * The lookup procedure itself, independent of how HTTP is done (curl on the runner, fakes in tests).
 * Never guesses: every doubt becomes a structured failure.
 */
import {
  extractCsrf,
  extractStreetsMap,
  findCity,
  findStreet,
  housesOf,
  looksLikeRealPage,
  resolveHouse,
} from './lookupCore.ts';
import type { LookupResult } from './lookupCore.ts';

export interface LookupJob {
  city: string;
  street: string;
  house: string;
}

export interface PageResponse {
  status: number;
  bytes: number;
  html: string;
}
export interface AjaxResponse {
  status: number;
  bytes: number;
  json?: unknown;
}
export interface DtekTransport {
  page(): Promise<PageResponse>;
  homes(csrf: string, city: string, street: string): Promise<AjaxResponse>;
}

const MAX_FIELD = 120;
const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

export function parseJob(raw: unknown): LookupJob | undefined {
  const j = raw as Partial<Record<keyof LookupJob, unknown>> | null;
  if (!j || typeof j !== 'object') return undefined;
  for (const k of ['city', 'street', 'house'] as const) {
    const v = j[k];
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_FIELD || !noControl(v)) return undefined;
  }
  return { city: j.city as string, street: j.street as string, house: j.house as string };
}

export async function runLookup(job: LookupJob, dtek: DtekTransport): Promise<LookupResult> {
  const page = await dtek.page();
  if (!looksLikeRealPage(page.status, page.bytes)) return { ok: false, reason: 'blocked' };

  const csrf = extractCsrf(page.html);
  const streets = extractStreetsMap(page.html);
  if (!csrf || !streets) return { ok: false, reason: 'parse' };

  const city = findCity(streets, job.city);
  if (city.kind === 'none') return { ok: false, reason: 'city_not_found' };
  if (city.kind === 'ambiguous') {
    return { ok: false, reason: 'city_ambiguous', candidates: city.candidates };
  }

  const street = findStreet(streets[city.value] ?? [], job.street);
  if (street.kind === 'none') return { ok: false, reason: 'street_not_found' };
  if (street.kind === 'ambiguous') {
    return { ok: false, reason: 'street_ambiguous', candidates: street.candidates };
  }

  const answer = await dtek.homes(csrf, city.value, street.value);
  if (answer.status !== 200) {
    return { ok: false, reason: answer.status === 403 || answer.bytes < 20 ? 'blocked' : 'parse' };
  }
  const houses = housesOf(answer.json);
  if (!houses) return { ok: false, reason: 'parse' };

  const r = resolveHouse(houses, job.house);
  return r.ok ? { ok: true, group: r.group } : { ok: false, reason: r.reason };
}
