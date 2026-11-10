/**
 * Private store of Web Push subscriptions (device endpoint + keys + notification settings).
 * These must NOT live in the public repository: an endpoint is an addressable device identifier.
 *
 *   POST /subscribe            browser, needs X-Invite (+ X-Device-Token once the device has one)
 *   POST /unsubscribe          browser, same auth
 *   GET  /internal/subscribers GitHub Action, Authorization: Bearer SUBS_SECRET
 *   POST /internal/remove      GitHub Action, same auth (dead endpoint cleanup)
 *
 * KV layout (one key per device, so there is no read-modify-write race on a shared blob):
 *   sub:<id>        -> stored profile (+ tokenHash)
 *   ep:<sha256(url)> -> <id>   (one record per physical endpoint)
 */
export const ALLOWED_ORIGINS = ['https://ukdc.github.io'];

export interface KVLike {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export interface SubsEnv {
  SUBS: KVLike;
  INVITE_CODES?: string;
  SUBS_SECRET?: string;
}

const MAX_BODY = 8192;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9.-]+\.notify\.windows\.com$/,
];

function corsHeaders(origin: string | null): Record<string, string> {
  const h: Record<string, string> = { Vary: 'Origin' };
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    h['Access-Control-Allow-Headers'] = 'Content-Type, X-Invite, X-Device-Token';
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

/** Constant-time string comparison (hashes first, so lengths do not leak). */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const [ha, hb] = await Promise.all([sha256Hex(a), sha256Hex(b)]);
  let diff = 0;
  for (let i = 0; i < ha.length; i++) diff |= ha.charCodeAt(i) ^ hb.charCodeAt(i);
  return diff === 0;
}

async function inviteOk(env: SubsEnv, code: string | null): Promise<boolean> {
  if (!code || !env.INVITE_CODES) return false;
  let ok = false;
  for (const c of env.INVITE_CODES.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (await safeEqual(code.trim(), c)) ok = true; // no early exit
  }
  return ok;
}

async function secretOk(env: SubsEnv, header: string | null): Promise<boolean> {
  if (!env.SUBS_SECRET || env.SUBS_SECRET.length < 24 || !header) return false;
  const m = /^Bearer (.+)$/.exec(header);
  return !!m && (await safeEqual(m[1], env.SUBS_SECRET));
}

const noControl = (v: string) => !/[\u0000-\u001f\u007f]/.test(v);

interface StoredProfile {
  id: string;
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } };
  addresses: Array<Record<string, unknown>>;
  quietHours: { enabled: boolean; start: string; end: string };
  updatedAt: string;
  tokenHash?: string;
}

/** Rebuilds the profile from a whitelist: nothing else from the request body is ever stored. */
export function sanitizeProfile(raw: any): Omit<StoredProfile, 'tokenHash' | 'updatedAt'> | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) return null;

  const sub = raw.subscription;
  if (!sub || typeof sub.endpoint !== 'string' || sub.endpoint.length > 600) return null;
  let url: URL;
  try {
    url = new URL(sub.endpoint);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return null;
  if (!PUSH_HOSTS.some((re) => re.test(url.hostname))) return null;
  const keys = sub.keys;
  if (
    !keys ||
    typeof keys.p256dh !== 'string' ||
    typeof keys.auth !== 'string' ||
    !/^[A-Za-z0-9_-]{60,100}$/.test(keys.p256dh) ||
    !/^[A-Za-z0-9_-]{16,32}$/.test(keys.auth)
  ) {
    return null;
  }

  if (!Array.isArray(raw.addresses) || raw.addresses.length > 10) return null;
  const addresses: Array<Record<string, unknown>> = [];
  for (const a of raw.addresses) {
    if (!a || typeof a !== 'object') return null;
    if (typeof a.id !== 'string' || !/^[\w-]{1,64}$/.test(a.id)) return null;
    if (a.region !== 'kem' && a.region !== 'krem') return null;
    if (typeof a.group !== 'string' || !/^\d{1,2}\.[12]$/.test(a.group)) return null;
    const shortTitle =
      typeof a.shortTitle === 'string' && a.shortTitle.length <= 80 && noControl(a.shortTitle)
        ? a.shortTitle
        : '';
    addresses.push({
      id: a.id,
      label: '',
      icon: '',
      region: a.region,
      city: '',
      street: '',
      house: '',
      group: a.group,
      notifyBeforeOff: a.notifyBeforeOff !== false,
      notifyBeforeOn: a.notifyBeforeOn !== false,
      notifyOnChange: a.notifyOnChange !== false,
      createdAt:
        typeof a.createdAt === 'string' && a.createdAt.length <= 40 && noControl(a.createdAt)
          ? a.createdAt
          : '',
      shortTitle,
    });
  }

  const q = raw.quietHours;
  const time = /^([01]\d|2[0-3]):[0-5]\d$/;
  const quietHours =
    q && typeof q === 'object' && typeof q.start === 'string' && typeof q.end === 'string' &&
    time.test(q.start) && time.test(q.end)
      ? { enabled: q.enabled === true, start: q.start, end: q.end }
      : { enabled: false, start: '23:00', end: '07:00' };

  return {
    id: raw.id,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    addresses,
    quietHours,
  };
}

function randomToken(): string {
  const b = new Uint8Array(16); // 128 bits
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

async function readJson(request: Request): Promise<any | null> {
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function removeById(env: SubsEnv, id: string): Promise<void> {
  const raw = await env.SUBS.get(`sub:${id}`);
  if (raw) {
    try {
      const p = JSON.parse(raw) as StoredProfile;
      const epKey = `ep:${await sha256Hex(p.subscription.endpoint)}`;
      if ((await env.SUBS.get(epKey)) === id) await env.SUBS.delete(epKey);
    } catch {
      // corrupt record: still delete it below
    }
  }
  await env.SUBS.delete(`sub:${id}`);
}

async function handleSubscribe(request: Request, env: SubsEnv, origin: string | null) {
  if (!(await inviteOk(env, request.headers.get('X-Invite')))) {
    return json({ error: 'invite' }, 401, origin);
  }
  const profile = sanitizeProfile(await readJson(request));
  if (!profile) return json({ error: 'invalid' }, 400, origin);

  const existingRaw = await env.SUBS.get(`sub:${profile.id}`);
  const existing: StoredProfile | null = existingRaw ? JSON.parse(existingRaw) : null;
  let tokenHash = existing?.tokenHash;
  let issuedToken: string | undefined;
  if (tokenHash) {
    const t = request.headers.get('X-Device-Token');
    if (!t || !(await safeEqual(await sha256Hex(t), tokenHash))) {
      return json({ error: 'token' }, 403, origin);
    }
  } else {
    // new device, or a record migrated without a token: the first valid invite claims it
    issuedToken = randomToken();
    tokenHash = await sha256Hex(issuedToken);
  }

  // one record per physical endpoint: a re-registered device replaces its previous record
  const epKey = `ep:${await sha256Hex(profile.subscription.endpoint)}`;
  const otherId = await env.SUBS.get(epKey);
  if (otherId && otherId !== profile.id) await removeById(env, otherId);
  // the device may have switched endpoint under the same id
  if (existing && existing.subscription.endpoint !== profile.subscription.endpoint) {
    await env.SUBS.delete(`ep:${await sha256Hex(existing.subscription.endpoint)}`);
  }

  const stored: StoredProfile = { ...profile, updatedAt: new Date().toISOString(), tokenHash };
  await env.SUBS.put(`sub:${profile.id}`, JSON.stringify(stored));
  await env.SUBS.put(epKey, profile.id);
  return json(issuedToken ? { ok: true, token: issuedToken } : { ok: true }, 200, origin);
}

async function handleUnsubscribe(request: Request, env: SubsEnv, origin: string | null) {
  if (!(await inviteOk(env, request.headers.get('X-Invite')))) {
    return json({ error: 'invite' }, 401, origin);
  }
  const body = await readJson(request);
  const id = body?.id;
  if (typeof id !== 'string' || !ID_RE.test(id)) return json({ error: 'invalid' }, 400, origin);
  const raw = await env.SUBS.get(`sub:${id}`);
  if (raw) {
    const p = JSON.parse(raw) as StoredProfile;
    const t = request.headers.get('X-Device-Token');
    if (!p.tokenHash || !t || !(await safeEqual(await sha256Hex(t), p.tokenHash))) {
      return json({ error: 'token' }, 403, origin);
    }
    await removeById(env, id);
  }
  return json({ ok: true }, 200, origin);
}

/** A subscription not refreshed for this long is treated as an abandoned install (e.g. a reinstalled PWA). */
export const STALE_AFTER_DAYS = 30;

/**
 * Deletes subscriptions whose `updatedAt` is older than the TTL (and their `ep:` keys).
 * Records without a parsable `updatedAt` are kept: never delete what we cannot judge.
 */
export async function purgeStale(
  env: SubsEnv,
  now: Date = new Date(),
  maxAgeDays = STALE_AFTER_DAYS
): Promise<number> {
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  const stale: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const raw = await env.SUBS.get(k.name);
      if (!raw) continue;
      try {
        const t = Date.parse((JSON.parse(raw) as StoredProfile).updatedAt);
        if (Number.isFinite(t) && t < cutoff) stale.push(k.name.slice('sub:'.length));
      } catch {
        // corrupt record: keep
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  for (const id of stale) await removeById(env, id);
  return stale.length;
}

async function listAll(env: SubsEnv): Promise<StoredProfile[]> {
  const out: StoredProfile[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.SUBS.list({ prefix: 'sub:', cursor });
    for (const k of page.keys) {
      const raw = await env.SUBS.get(k.name);
      if (!raw) continue;
      try {
        out.push(JSON.parse(raw));
      } catch {
        // skip corrupt record
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return out;
}

export async function handleRequest(request: Request, env: SubsEnv): Promise<Response> {
  const origin = request.headers.get('Origin');
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(origin) });
  }

  if (pathname.startsWith('/internal/')) {
    // server-to-server only: no CORS headers are ever added
    if (!(await secretOk(env, request.headers.get('Authorization')))) {
      return json({ error: 'unauthorized' }, 401, null);
    }
    if (pathname === '/internal/subscribers' && request.method === 'GET') {
      const all = (await listAll(env)).map(({ tokenHash: _t, ...rest }) => rest);
      return json({ subscribers: all }, 200, null);
    }
    if (pathname === '/internal/remove' && request.method === 'POST') {
      const body = await readJson(request);
      if (typeof body?.endpoint !== 'string') return json({ error: 'invalid' }, 400, null);
      const id = await env.SUBS.get(`ep:${await sha256Hex(body.endpoint)}`);
      if (id) await removeById(env, id);
      return json({ ok: true, removed: !!id }, 200, null);
    }
    return json({ error: 'not found' }, 404, null);
  }

  // browser endpoints: only from the app's own origin
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
    return json({ error: 'forbidden origin' }, 403, null);
  }
  if (pathname === '/subscribe' && request.method === 'POST') {
    return handleSubscribe(request, env, origin);
  }
  if (pathname === '/unsubscribe' && request.method === 'POST') {
    return handleUnsubscribe(request, env, origin);
  }
  return json({ error: 'not found' }, 404, origin);
}
