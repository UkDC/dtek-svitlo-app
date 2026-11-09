/**
 * Group lookup for Kyiv-oblast addresses. The app asks the svitlo-lookup Worker, which makes a
 * GitHub Actions runner visit dtek-krem.com.ua (DTEK blocks Cloudflare). Source: cloudflare/lookup/.
 *
 * It takes 20-90 s, and KV between Cloudflare locations is only eventually consistent, so the poll
 * is patient (150 s) and survives a few failed polls.
 */
export const LOOKUP_API_URL: string =
  (import.meta as any).env?.VITE_LOOKUP_API_URL ||
  'https://svitlo-lookup.svitlo-b79d27.workers.dev';

export interface OblastAddressQuery {
  city: string;
  street: string;
  house: string;
}

/** Why a lookup produced no group. Server reasons plus client-side ones. */
export type OblastFailureReason =
  | 'city_not_found'
  | 'city_ambiguous'
  | 'street_not_found'
  | 'street_ambiguous'
  | 'house_not_found'
  | 'group_unknown'
  | 'group_ambiguous'
  | 'blocked'
  | 'parse'
  | 'timeout' // server gave up waiting for the runner
  | 'expired'
  | 'invite' // 401: the code was not accepted
  | 'limit' // 429: daily cap reached
  | 'service' // Worker or GitHub unavailable
  | 'network' // no connection
  | 'cancelled';

export type OblastLookupOutcome =
  | { ok: true; group: string }
  | { ok: false; reason: OblastFailureReason; candidates?: string[] };

export interface OblastLookupOptions {
  invite: string;
  signal?: AbortSignal;
  onState?: (state: 'queued' | 'running') => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  baseUrl?: string;
  pollIntervalMs?: number;
  totalTimeoutMs?: number;
}

const KNOWN_REASONS: ReadonlySet<string> = new Set([
  'city_not_found', 'city_ambiguous', 'street_not_found', 'street_ambiguous',
  'house_not_found', 'group_unknown', 'group_ambiguous', 'blocked', 'parse',
  'timeout', 'expired',
]);

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function lookupOblastGroup(
  query: OblastAddressQuery,
  opts: OblastLookupOptions
): Promise<OblastLookupOutcome> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? Date.now;
  const base = (opts.baseUrl ?? LOOKUP_API_URL).replace(/\/+$/, '');
  const interval = opts.pollIntervalMs ?? 3000;
  const total = opts.totalTimeoutMs ?? 150_000;
  const cancelled = (): OblastLookupOutcome => ({ ok: false, reason: 'cancelled' });

  let id: string;
  try {
    const res = await f(`${base}/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Invite': opts.invite.trim() },
      body: JSON.stringify({
        city: query.city.trim(),
        street: query.street.trim(),
        house: query.house.trim(),
      }),
      signal: opts.signal,
    });
    if (res.status === 401) return { ok: false, reason: 'invite' };
    if (res.status === 429) return { ok: false, reason: 'limit' };
    if (!res.ok) return { ok: false, reason: 'service' };
    const body = await res.json().catch(() => null);
    if (!body || typeof body.id !== 'string') return { ok: false, reason: 'service' };
    id = body.id;
  } catch {
    return opts.signal?.aborted ? cancelled() : { ok: false, reason: 'network' };
  }

  const deadline = now() + total;
  let failedPolls = 0;
  while (now() < deadline) {
    await sleep(interval);
    if (opts.signal?.aborted) return cancelled();
    try {
      const res = await f(`${base}/result?id=${encodeURIComponent(id)}`, { signal: opts.signal });
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      failedPolls = 0;
      if (body.state === 'done' && typeof body.group === 'string') {
        return { ok: true, group: body.group };
      }
      if (body.state === 'failed') {
        const reason = KNOWN_REASONS.has(body.reason) ? (body.reason as OblastFailureReason) : 'service';
        const candidates = Array.isArray(body.candidates)
          ? body.candidates.filter((c: unknown): c is string => typeof c === 'string')
          : undefined;
        return { ok: false, reason, ...(candidates?.length ? { candidates } : {}) };
      }
      if (body.state === 'queued' || body.state === 'running') opts.onState?.(body.state);
    } catch {
      if (opts.signal?.aborted) return cancelled();
      if (++failedPolls >= 4) return { ok: false, reason: 'network' };
    }
  }
  return { ok: false, reason: 'timeout' };
}

/** User-facing text (Ukrainian). `candidates` are shown separately as buttons. */
export function oblastFailureText(reason: OblastFailureReason): string {
  switch (reason) {
    case 'city_not_found':
      return 'Населений пункт не знайдено на сайті ДТЕК. Перевірте написання (наприклад, «м. Бориспіль»).';
    case 'city_ambiguous':
      return 'На сайті ДТЕК є кілька таких населених пунктів. Оберіть свій:';
    case 'street_not_found':
      return 'Вулицю не знайдено на сайті ДТЕК для цього населеного пункту. Перевірте написання.';
    case 'street_ambiguous':
      return 'Схожих вулиць кілька. Оберіть свою:';
    case 'house_not_found':
      return 'Будинок з таким номером не знайдено на цій вулиці. Спробуйте інший запис номера (наприклад, «24Б» замість «24 б»).';
    case 'group_unknown':
    case 'group_ambiguous':
      return 'ДТЕК не дав однозначної групи для цього будинку. Оберіть групу вручну нижче.';
    case 'blocked':
    case 'parse':
      return 'Сайт ДТЕК зараз не вдалося опитати. Спробуйте пізніше або оберіть групу вручну нижче.';
    case 'timeout':
    case 'expired':
      return 'Перевірка тривала надто довго. Спробуйте ще раз або оберіть групу вручну нижче.';
    case 'invite':
      return 'Код-запрошення не підійшов. Перевірте його.';
    case 'limit':
      return 'Сьогодні ліміт перевірок вичерпано. Спробуйте завтра або оберіть групу вручну нижче.';
    case 'service':
      return 'Сервіс визначення групи зараз недоступний. Спробуйте пізніше або оберіть групу вручну нижче.';
    case 'network':
      return 'Немає зв’язку із сервісом. Перевірте інтернет і спробуйте ще раз.';
    case 'cancelled':
      return '';
  }
}
