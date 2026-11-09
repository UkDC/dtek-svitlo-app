/**
 * Group lookup for Kyiv-oblast addresses (DTEK blocks Cloudflare, so a GitHub Actions runner does
 * the actual visit). This Worker is the job queue between the app and that runner.
 *
 *   POST /start            app, needs Origin + X-Invite. Body {city, street, house} -> {id}
 *   GET  /result?id=       app. -> {state: queued|running|done|failed, …}
 *   GET  /internal/job?id  runner, Bearer LOOKUP_SECRET. One-time read of the address.
 *   POST /internal/result?id  runner, same auth.
 *
 * KV (TTL 10 min everywhere, so an address does not outlive its lookup):
 *   job:<id>  the address (deleted when the runner reads it)
 *   res:<id>  {state, createdAt, …} (never contains the address)
 *   cap:<UTC date> daily counter
 *
 * KV is eventually consistent (~60 s between edges): the runner therefore retries reading the job
 * and the app keeps polling for a couple of minutes.
 */
export const ALLOWED_ORIGINS = ['https://ukdc.github.io'];
export const WORKFLOW = 'dtek-lookup.yml';
export const REF = 'main';

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface LookupEnv {
  LOOKUPS: KVLike;
  REPO: string;
  DAILY_LIMIT?: string;
  GITHUB_TOKEN?: string;
  LOOKUP_SECRET?: string;
  INVITE_CODES?: string;
}

const TTL = 600;
/** After this long without a result the app is told the lookup failed. */
const STALE_MS = 4 * 60 * 1000;
const MAX_BODY = 2048;
const MAX_FIELD = 120;
const ID_RE = /^[0-9a-f]{32}$/;
const REASONS = [
  'city_not_found', 'city_ambiguous', 'street_not_found', 'street_ambiguous',
  'house_not_found', 'group_unknown', 'group_ambiguous', 'blocked', 'parse',
];

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Invite';
    h['Access-Control-Max-Age'] = '86400';
  }
  return h;
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function inviteOk(env: LookupEnv, code: string | null): Promise<boolean> {
  if (!code || !env.INVITE_CODES) return false;
  let ok = false;
  for (const c of env.INVITE_CODES.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (await safeEqual(code.trim(), c)) ok = true; // no early exit
  }
  return ok;
}

async function secretOk(env: LookupEnv, header: string | null): Promise<boolean> {
  if (!env.LOOKUP_SECRET || env.LOOKUP_SECRET.length < 24 || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  return !!m && (await safeEqual(m[1], env.LOOKUP_SECRET));
}

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

async function readJson(request: Request): Promise<any | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

interface Address {
  city: string;
  street: string;
  house: string;
}

function parseAddress(raw: any): Address | null {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of ['city', 'street', 'house']) {
    const v = raw[k];
    if (typeof v !== 'string' || !v.trim() || v.length > MAX_FIELD || !noControl(v)) return null;
  }
  return { city: raw.city.trim(), street: raw.street.trim(), house: raw.house.trim() };
}

function randomId(): string {
  const b = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

interface Res {
  state: 'queued' | 'running' | 'done' | 'failed';
  createdAt: number;
  group?: string;
  reason?: string;
  candidates?: string[];
}

async function readRes(env: LookupEnv, id: string): Promise<Res | null> {
  const raw = await env.LOOKUPS.get(`res:${id}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Res;
  } catch {
    return null;
  }
}

const writeRes = (env: LookupEnv, id: string, res: Res) =>
  env.LOOKUPS.put(`res:${id}`, JSON.stringify(res), { expirationTtl: TTL });

async function dispatchLookup(env: LookupEnv, jobId: string, fetchImpl: typeof fetch): Promise<boolean> {
  if (!env.GITHUB_TOKEN) return false;
  const url = `https://api.github.com/repos/${env.REPO}/actions/workflows/${WORKFLOW}/dispatches`;
  const init: RequestInit = {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'svitlo-lookup',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: REF, inputs: { job_id: jobId } }),
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.status === 204) return true;
      if (res.status < 500) return false; // configuration error: retrying will not help
    } catch {
      // network hiccup: one retry
    }
  }
  return false;
}

async function takeDailySlot(env: LookupEnv, now: number): Promise<boolean> {
  const limit = Number.parseInt(env.DAILY_LIMIT ?? '40', 10);
  const key = `cap:${new Date(now).toISOString().slice(0, 10)}`;
  const used = Number.parseInt((await env.LOOKUPS.get(key)) ?? '0', 10) || 0;
  if (used >= (Number.isFinite(limit) ? limit : 40)) return false;
  // not atomic; for a handful of users an occasional off-by-one is irrelevant
  await env.LOOKUPS.put(key, String(used + 1), { expirationTtl: 2 * 86400 });
  return true;
}

async function handleStart(request: Request, env: LookupEnv, origin: string, fetchImpl: typeof fetch, now: number) {
  if (!(await inviteOk(env, request.headers.get('X-Invite')))) {
    return json({ error: 'invite' }, 401, origin);
  }
  const address = parseAddress(await readJson(request));
  if (!address) return json({ error: 'invalid' }, 400, origin);
  if (!(await takeDailySlot(env, now))) return json({ error: 'limit' }, 429, origin);

  const id = randomId();
  await env.LOOKUPS.put(`job:${id}`, JSON.stringify(address), { expirationTtl: TTL });
  await writeRes(env, id, { state: 'queued', createdAt: now });
  if (!(await dispatchLookup(env, id, fetchImpl))) {
    await env.LOOKUPS.delete(`job:${id}`);
    await env.LOOKUPS.delete(`res:${id}`);
    return json({ error: 'dispatch' }, 502, origin);
  }
  return json({ id }, 200, origin);
}

async function handleResult(url: URL, env: LookupEnv, origin: string, now: number) {
  const id = url.searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) return json({ error: 'invalid' }, 400, origin);
  const res = await readRes(env, id);
  if (!res) return json({ state: 'failed', reason: 'expired' }, 200, origin);
  if ((res.state === 'queued' || res.state === 'running') && now - res.createdAt > STALE_MS) {
    return json({ state: 'failed', reason: 'timeout' }, 200, origin);
  }
  if (res.state === 'done') return json({ state: 'done', group: res.group }, 200, origin);
  if (res.state === 'failed') {
    return json({ state: 'failed', reason: res.reason, candidates: res.candidates }, 200, origin);
  }
  return json({ state: res.state }, 200, origin);
}

function parseResult(raw: any): Omit<Res, 'createdAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.ok === true) {
    return typeof raw.group === 'string' && /^[1-6]\.[12]$/.test(raw.group)
      ? { state: 'done', group: raw.group }
      : null;
  }
  if (raw.ok !== false || !REASONS.includes(raw.reason)) return null;
  let candidates: string[] | undefined;
  if (raw.candidates !== undefined) {
    if (!Array.isArray(raw.candidates) || raw.candidates.length > 8) return null;
    if (!raw.candidates.every((c: unknown) => typeof c === 'string' && c.length <= 100 && noControl(c))) {
      return null;
    }
    candidates = raw.candidates;
  }
  return { state: 'failed', reason: raw.reason, ...(candidates ? { candidates } : {}) };
}

async function handleInternal(request: Request, url: URL, env: LookupEnv, now: number) {
  if (!(await secretOk(env, request.headers.get('Authorization')))) {
    return json({ error: 'unauthorized' }, 401, null);
  }
  const id = url.searchParams.get('id') ?? '';
  if (!ID_RE.test(id)) return json({ error: 'invalid' }, 400, null);

  if (url.pathname === '/internal/job' && request.method === 'GET') {
    const raw = await env.LOOKUPS.get(`job:${id}`);
    if (!raw) return json({ error: 'not found' }, 404, null);
    await env.LOOKUPS.delete(`job:${id}`); // one-time: the address does not stay in KV
    const res = await readRes(env, id);
    if (res && res.state === 'queued') await writeRes(env, id, { ...res, state: 'running' });
    return new Response(raw, {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  if (url.pathname === '/internal/result' && request.method === 'POST') {
    const result = parseResult(await readJson(request));
    if (!result) return json({ error: 'invalid' }, 400, null);
    const res = await readRes(env, id);
    if (!res) return json({ error: 'not found' }, 404, null);
    if (res.state === 'done' || res.state === 'failed') return json({ ok: true, duplicate: true }, 200, null);
    await writeRes(env, id, { createdAt: res.createdAt || now, ...result });
    await env.LOOKUPS.delete(`job:${id}`);
    return json({ ok: true }, 200, null);
  }
  return json({ error: 'not found' }, 404, null);
}

export async function handleRequest(
  request: Request,
  env: LookupEnv,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now()
): Promise<Response> {
  const origin = request.headers.get('Origin');
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (url.pathname.startsWith('/internal/')) {
    // server-to-server only: no CORS headers are ever added
    return handleInternal(request, url, env, now);
  }

  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'forbidden origin' }, 403, null);
  }
  if (url.pathname === '/start' && request.method === 'POST') {
    return handleStart(request, env, origin, fetchImpl, now);
  }
  if (url.pathname === '/result' && request.method === 'GET') {
    return handleResult(url, env, origin, now);
  }
  return json({ error: 'not found' }, 404, origin);
}
