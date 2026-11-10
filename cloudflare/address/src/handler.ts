/**
 * Read-only CORS proxy for the YASNO address API (Kyiv city only: regionId=25, dsoId=902).
 *
 * Why: app.yasno.ua sends no Access-Control-Allow-Origin, so the PWA on GitHub Pages cannot call it
 * from the browser (see docs/ARCHITECTURE.md §2). This Worker forwards exactly three fixed
 * endpoints and nothing else:
 *   GET /streets?query=<2..40 chars>
 *   GET /houses?streetId=<n>&query=<1..20 chars>
 *   GET /group?streetId=<n>&houseId=<n>
 *   GET /diag    -> runs one sample lookup and reports upstream status codes (for a human to open)
 * Browser calls are only answered for the allowed origins; no secrets, no state.
 */
export const ALLOWED_ORIGINS = ['https://ukdc.github.io'];
export const YASNO_BASE =
  'https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2';
const KYIV = 'regionId=25&dsoId=902';
const MAX_ITEMS = 50;

type FetchLike = (url: string, init?: any) => Promise<Response>;

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, OPTIONS';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null, cacheSeconds = 0): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cacheSeconds ? `public, max-age=${cacheSeconds}` : 'no-store',
      ...corsHeaders(origin),
    },
  });
}

const isId = (v: string | null): v is string => !!v && /^\d{1,9}$/.test(v);
// printable text only, bounded length (no control characters, no URL syntax abuse: it is re-encoded anyway)
const isText = (v: string | null, min: number, max: number): v is string =>
  v !== null && v.length >= min && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v);

async function upstream(
  fetchImpl: FetchLike,
  path: string
): Promise<{ ok: boolean; status: number; data: unknown }> {
  try {
    const res = await fetchImpl(`${YASNO_BASE}${path}`, {
      headers: { Accept: 'application/json', 'User-Agent': 'svitlo-address-proxy/1.0' },
      signal: AbortSignal.timeout(6000),
      cf: { cacheTtl: 3600, cacheEverything: true },
    });
    if (!res.ok) return { ok: false, status: res.status, data: null };
    return { ok: true, status: res.status, data: await res.json() };
  } catch {
    return { ok: false, status: 0, data: null };
  }
}

export async function handleRequest(
  request: Request,
  fetchImpl: FetchLike = (u, i) => fetch(u, i)
): Promise<Response> {
  const origin = request.headers.get('Origin');
  if (origin && !ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'origin_not_allowed' }, 403, null);
  }
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405, origin);

  const url = new URL(request.url);
  const q = url.searchParams;

  if (url.pathname === '/streets') {
    const query = q.get('query');
    if (!isText(query, 2, 40)) return json({ error: 'bad_query' }, 400, origin);
    const r = await upstream(fetchImpl, `/streets?${KYIV}&query=${encodeURIComponent(query)}`);
    if (!r.ok || !Array.isArray(r.data)) return json({ error: 'upstream', status: r.status }, 502, origin);
    return json(r.data.slice(0, MAX_ITEMS), 200, origin, 3600);
  }

  if (url.pathname === '/houses') {
    const streetId = q.get('streetId');
    const query = q.get('query') ?? '';
    if (!isId(streetId) || !isText(query, 0, 20)) return json({ error: 'bad_query' }, 400, origin);
    const r = await upstream(
      fetchImpl,
      `/houses?${KYIV}&streetId=${streetId}&query=${encodeURIComponent(query)}`
    );
    if (!r.ok || !Array.isArray(r.data)) return json({ error: 'upstream', status: r.status }, 502, origin);
    return json(r.data.slice(0, MAX_ITEMS), 200, origin, 3600);
  }

  if (url.pathname === '/group') {
    const streetId = q.get('streetId');
    const houseId = q.get('houseId');
    if (!isId(streetId) || !isId(houseId)) return json({ error: 'bad_query' }, 400, origin);
    const r = await upstream(fetchImpl, `/group?${KYIV}&streetId=${streetId}&houseId=${houseId}`);
    if (!r.ok || typeof r.data !== 'object' || r.data === null) {
      return json({ error: 'upstream', status: r.status }, 502, origin);
    }
    return json(r.data, 200, origin, 3600);
  }

  if (url.pathname === '/diag') {
    const out: Record<string, unknown> = {};
    const s = await upstream(fetchImpl, `/streets?${KYIV}&query=${encodeURIComponent('Хрещ')}`);
    out.streets = { status: s.status, count: Array.isArray(s.data) ? s.data.length : null };
    // Is the YASNO street search case-insensitive? (the client sends a capitalised probe either way)
    const lower = await upstream(fetchImpl, `/streets?${KYIV}&query=${encodeURIComponent('хрещ')}`);
    out.streetsLowercase = { status: lower.status, count: Array.isArray(lower.data) ? lower.data.length : null };
    const first = Array.isArray(s.data) ? (s.data[0] as any) : null;
    if (first?.id) {
      const h = await upstream(fetchImpl, `/houses?${KYIV}&streetId=${first.id}&query=1`);
      out.houses = { status: h.status, count: Array.isArray(h.data) ? h.data.length : null };
      const fh = Array.isArray(h.data) ? (h.data[0] as any) : null;
      if (fh?.id) {
        const g = await upstream(fetchImpl, `/group?${KYIV}&streetId=${first.id}&houseId=${fh.id}`);
        out.group = { status: g.status, sample: g.data };
      }
    }
    // Sweep neighbouring operator codes in region 25: does any answer street search for oblast streets?
    const sweep: Record<string, unknown> = {};
    for (let dso = 900; dso <= 910; dso++) {
      const r = await upstream(fetchImpl, `/streets?regionId=25&dsoId=${dso}&query=${encodeURIComponent('Центральна')}`);
      const sample = Array.isArray(r.data) && r.data[0] ? String((r.data[0] as any).value ?? '') : null;
      sweep[String(dso)] = { status: r.status, count: Array.isArray(r.data) ? r.data.length : null, sample };
    }
    out.dsoSweep = sweep;
    // Does YASNO also cover Kyiv oblast? List the regions/operators it knows (public reference data only).
    try {
      const rr = await (fetchImpl as FetchLike)(
        'https://app.yasno.ua/api/blackout-service/public/shutdowns/regions',
        { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000) }
      );
      const rd: any = rr.ok ? await rr.json() : null;
      out.yasnoRegions = Array.isArray(rd)
        ? rd.map((r: any) => ({
            id: r?.id,
            name: r?.value,
            dsos: Array.isArray(r?.dsos) ? r.dsos.map((d: any) => ({ id: d?.id, name: d?.name })) : [],
          }))
        : { status: rr.status };
    } catch {
      out.yasnoRegions = { status: 0 };
    }
    out.dtekKem = await probeDtekPage(fetchImpl, 'https://www.dtek-kem.com.ua/ua/shutdowns');
    out.dtekKrem = await probeDtekPage(fetchImpl, 'https://www.dtek-krem.com.ua/ua/shutdowns');
    return json(out, 200, origin);
  }

  return json({ error: 'not_found' }, 404, origin);
}

/** Does DTEK let a Cloudflare datacenter IP read its shutdowns page? (only flags are reported) */
export async function probeDtekPage(
  fetchImpl: FetchLike,
  pageUrl: string
): Promise<Record<string, unknown>> {
  try {
    const res = await fetchImpl(pageUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; svitlo-diag/1.0)', Accept: 'text/html' },
      signal: AbortSignal.timeout(8000),
    });
    const text = await res.text();
    return {
      status: res.status,
      bytes: text.length,
      hasSchedule: text.includes('DisconSchedule'),
      hasCsrf: /csrf-token/i.test(text),
      looksBlocked: /incapsula|imperva|hcaptcha|_Incapsula_Resource/i.test(text),
    };
  } catch (e) {
    return { status: 0, error: 'fetch_failed' };
  }
}
