import { describe, expect, it, vi } from 'vitest';
import { handleRequest, WORKFLOW, REF } from '../cloudflare/lookup/src/handler.ts';
import type { LookupEnv } from '../cloudflare/lookup/src/handler.ts';

const ORIGIN = 'https://ukdc.github.io';
const SECRET = 'x'.repeat(32);
const NOW = Date.UTC(2026, 10, 9, 12, 0, 0);

function makeEnv(over: Partial<LookupEnv> = {}) {
  const store = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const env: LookupEnv = {
    LOOKUPS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v, o) => {
        store.set(k, v);
        ttls.set(k, o?.expirationTtl);
      },
      delete: async (k) => {
        store.delete(k);
      },
    },
    REPO: 'UkDC/dtek-svitlo-app',
    GITHUB_TOKEN: 'ghp_test',
    LOOKUP_SECRET: SECRET,
    INVITE_CODES: 'code-one, code-two',
    ...over,
  };
  return { env, store, ttls };
}

const ok204 = () => vi.fn(async () => new Response(null, { status: 204 }));
const address = { city: 'Бориспіль', street: 'Київський Шлях', house: '9' };

const start = (env: LookupEnv, body: unknown, f = ok204(), headers: Record<string, string> = {}, now = NOW) =>
  handleRequest(
    new Request('https://w.example/start', {
      method: 'POST',
      headers: { Origin: ORIGIN, 'X-Invite': 'code-two', ...headers },
      body: JSON.stringify(body),
    }),
    env,
    f as unknown as typeof fetch,
    now
  );

const internal = (path: string, method = 'GET', body?: unknown, auth = `Bearer ${SECRET}`) =>
  new Request(`https://w.example${path}`, {
    method,
    headers: { Authorization: auth },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const result = (env: LookupEnv, id: string, now = NOW) =>
  handleRequest(new Request(`https://w.example/result?id=${id}`, { headers: { Origin: ORIGIN } }), env, fetch, now);

describe('lookup worker: start', () => {
  it('queues a job, stores the address with a TTL and dispatches the fixed workflow', async () => {
    const { env, store, ttls } = makeEnv();
    const f = ok204();
    const res = await start(env, address, f);
    expect(res.status).toBe(200);
    const { id } = await res.json();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.parse(store.get(`job:${id}`)!)).toEqual(address);
    expect(ttls.get(`job:${id}`)).toBe(600);

    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.github.com/repos/UkDC/dtek-svitlo-app/actions/workflows/${WORKFLOW}/dispatches`);
    expect(JSON.parse(init.body as string)).toEqual({ ref: REF, inputs: { job_id: id } });
    // the address must not travel through the public workflow inputs
    expect(init.body).not.toContain('Бориспіль');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer ghp_test');
  });

  it('requires the app origin and an invite code', async () => {
    const { env } = makeEnv();
    const f = ok204();
    const bad = await handleRequest(
      new Request('https://w.example/start', { method: 'POST', headers: { Origin: 'https://evil.example', 'X-Invite': 'code-one' }, body: JSON.stringify(address) }),
      env, f as unknown as typeof fetch, NOW
    );
    expect(bad.status).toBe(403);
    expect((await start(env, address, f, { 'X-Invite': 'nope' })).status).toBe(401);
    expect((await start(env, address, f, { 'X-Invite': '' })).status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });

  it('rejects malformed bodies', async () => {
    const { env } = makeEnv();
    for (const body of [
      {}, { ...address, house: '' }, { ...address, city: 5 }, { ...address, street: 'x'.repeat(121) },
      { ...address, house: '9\n' }, null,
    ]) {
      expect((await start(env, body)).status).toBe(400);
    }
  });

  it('enforces the daily cap and resets on the next UTC day', async () => {
    const { env } = makeEnv({ DAILY_LIMIT: '2' });
    expect((await start(env, address)).status).toBe(200);
    expect((await start(env, address)).status).toBe(200);
    expect((await start(env, address)).status).toBe(429);
    expect((await start(env, address, ok204(), {}, NOW + 86_400_000)).status).toBe(200);
  });

  it('cleans up and returns 502 when GitHub refuses the dispatch', async () => {
    const { env, store } = makeEnv();
    const f = vi.fn(async () => new Response('nope', { status: 403 }));
    const res = await start(env, address, f as never);
    expect(res.status).toBe(502);
    expect([...store.keys()].filter((k) => k.startsWith('job:') || k.startsWith('res:'))).toEqual([]);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('retries a 5xx dispatch once', async () => {
    const { env } = makeEnv();
    const f = vi.fn().mockResolvedValueOnce(new Response('', { status: 502 })).mockResolvedValueOnce(new Response(null, { status: 204 }));
    expect((await start(env, address, f as never)).status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('fails closed without a GitHub token', async () => {
    const { env } = makeEnv({ GITHUB_TOKEN: undefined });
    expect((await start(env, address)).status).toBe(502);
  });
});

describe('lookup worker: lifecycle', () => {
  async function queued() {
    const ctx = makeEnv();
    const { id } = await (await start(ctx.env, address)).json();
    return { ...ctx, id };
  }

  it('queued -> running -> done, and the address is gone after the runner reads it', async () => {
    const { env, store, id } = await queued();
    expect(await (await result(env, id)).json()).toEqual({ state: 'queued' });

    const job = await handleRequest(internal(`/internal/job?id=${id}`), env);
    expect(job.status).toBe(200);
    expect(await job.json()).toEqual(address);
    expect(store.has(`job:${id}`)).toBe(false);
    expect(await (await result(env, id)).json()).toEqual({ state: 'running' });
    expect((await handleRequest(internal(`/internal/job?id=${id}`), env)).status).toBe(404);

    const post = await handleRequest(internal(`/internal/result?id=${id}`, 'POST', { ok: true, group: '5.2' }), env);
    expect(post.status).toBe(200);
    expect(await (await result(env, id)).json()).toEqual({ state: 'done', group: '5.2' });
    // the stored result never contains the address
    expect(JSON.stringify([...store.values()])).not.toContain('Бориспіль');
  });

  it('failure results carry the reason and street candidates only', async () => {
    const { env, id } = await queued();
    await handleRequest(internal(`/internal/result?id=${id}`, 'POST', { ok: false, reason: 'street_ambiguous', candidates: ['вул. А', 'пров. А'] }), env);
    expect(await (await result(env, id)).json()).toEqual({ state: 'failed', reason: 'street_ambiguous', candidates: ['вул. А', 'пров. А'] });
  });

  it('first result wins', async () => {
    const { env, id } = await queued();
    await handleRequest(internal(`/internal/result?id=${id}`, 'POST', { ok: true, group: '1.1' }), env);
    const again = await handleRequest(internal(`/internal/result?id=${id}`, 'POST', { ok: true, group: '6.2' }), env);
    expect(await again.json()).toMatchObject({ duplicate: true });
    expect(await (await result(env, id)).json()).toEqual({ state: 'done', group: '1.1' });
  });

  it('rejects results outside the whitelist', async () => {
    const { env, id } = await queued();
    for (const body of [
      { ok: true, group: '7.1' }, { ok: true, group: '1.3' }, { ok: true }, { ok: false, reason: 'whatever' },
      { ok: false, reason: 'parse', candidates: new Array(9).fill('x') },
      { ok: false, reason: 'parse', candidates: [5] }, 'junk', null,
    ]) {
      expect((await handleRequest(internal(`/internal/result?id=${id}`, 'POST', body), env)).status).toBe(400);
    }
    expect(await (await result(env, id)).json()).toEqual({ state: 'queued' });
  });

  it('reports a stale job as timed out and an unknown id as expired', async () => {
    const { env, id } = await queued();
    expect(await (await result(env, id, NOW + 5 * 60_000)).json()).toEqual({ state: 'failed', reason: 'timeout' });
    expect(await (await result(env, 'a'.repeat(32))).json()).toEqual({ state: 'failed', reason: 'expired' });
    expect((await result(env, 'not-an-id')).status).toBe(400);
  });
});

describe('lookup worker: access control', () => {
  it('internal endpoints need the secret and never send CORS headers', async () => {
    const { env } = makeEnv();
    const id = 'a'.repeat(32);
    for (const auth of ['', 'Bearer wrong', `Basic ${SECRET}`]) {
      const res = await handleRequest(internal(`/internal/job?id=${id}`, 'GET', undefined, auth), env);
      expect(res.status).toBe(401);
      expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
    const noSecret = makeEnv({ LOOKUP_SECRET: undefined }).env;
    expect((await handleRequest(internal(`/internal/job?id=${id}`), noSecret)).status).toBe(401);
    const short = makeEnv({ LOOKUP_SECRET: 'short' }).env;
    expect((await handleRequest(internal(`/internal/job?id=${id}`, 'GET', undefined, 'Bearer short'), short)).status).toBe(401);
  });

  it('browser endpoints require the app origin; preflight is limited to it', async () => {
    const { env } = makeEnv();
    const id = 'a'.repeat(32);
    expect((await handleRequest(new Request(`https://w.example/result?id=${id}`), env)).status).toBe(403);
    const pre = await handleRequest(new Request('https://w.example/start', { method: 'OPTIONS', headers: { Origin: ORIGIN } }), env);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const evil = await handleRequest(new Request('https://w.example/start', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } }), env);
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});
