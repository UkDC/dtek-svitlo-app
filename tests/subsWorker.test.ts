import { describe, expect, it } from 'vitest';
import { KVLike, SubsEnv, handleRequest, sanitizeProfile } from '../cloudflare/subs/src/handler';

function memoryKV(): KVLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    async get(k) {
      return data.get(k) ?? null;
    },
    async put(k, v) {
      data.set(k, v);
    },
    async delete(k) {
      data.delete(k);
    },
    async list({ prefix }) {
      return {
        keys: [...data.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
        list_complete: true,
      };
    },
  };
}

const ORIGIN = 'https://ukdc.github.io';
const INVITE = 'AAAA-BBBB-CCCC-DDDD';
const SECRET = 'x'.repeat(40);
const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);

function profile(over: Record<string, unknown> = {}) {
  return {
    id: 'ios_test_device_1',
    subscription: {
      endpoint: 'https://web.push.apple.com/QWERTY1',
      keys: { p256dh: P256DH, auth: AUTH },
    },
    addresses: [
      {
        id: 'a1',
        region: 'kem',
        group: '13.1',
        notifyBeforeOff: true,
        notifyBeforeOn: true,
        notifyOnChange: true,
        createdAt: '2026-01-01T00:00:00Z',
        shortTitle: 'Київ',
        street: 'ПРИВАТНА ВУЛИЦЯ',
        house: '17/3',
      },
    ],
    quietHours: { enabled: true, start: '23:00', end: '07:00' },
    ...over,
  };
}

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`https://subs.test${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function setup() {
  const kv = memoryKV();
  const env: SubsEnv = { SUBS: kv, INVITE_CODES: `${INVITE},OTHER-CODE-0000-1111`, SUBS_SECRET: SECRET };
  return { kv, env };
}

const internalGet = (path: string, token = SECRET) =>
  new Request(`https://subs.test${path}`, { headers: { Authorization: `Bearer ${token}` } });

describe('subscription store Worker', () => {
  it('rejects a request without a valid invite code', async () => {
    const { env, kv } = setup();
    expect((await handleRequest(post('/subscribe', profile()), env)).status).toBe(401);
    expect(
      (await handleRequest(post('/subscribe', profile(), { 'X-Invite': 'wrong' }), env)).status
    ).toBe(401);
    expect(kv.data.size).toBe(0);
  });

  it('rejects browser calls from a foreign origin', async () => {
    const { env } = setup();
    const req = new Request('https://subs.test/subscribe', {
      method: 'POST',
      headers: { Origin: 'https://evil.example', 'X-Invite': INVITE },
      body: JSON.stringify(profile()),
    });
    expect((await handleRequest(req, env)).status).toBe(403);
  });

  it('stores a device, issues a write token once, never stores address details', async () => {
    const { env, kv } = setup();
    const res = await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    const stored = kv.data.get('sub:ios_test_device_1')!;
    expect(stored).not.toContain('ПРИВАТНА');
    expect(stored).not.toContain('17/3');
    expect(stored).not.toContain(body.token); // only the hash is kept
    expect(JSON.parse(stored).addresses[0].group).toBe('13.1');
  });

  it('requires the device token for later updates of the same id', async () => {
    const { env } = setup();
    const first: any = await (
      await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env)
    ).json();
    const noToken = await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    expect(noToken.status).toBe(403);
    const wrong = await handleRequest(
      post('/subscribe', profile(), { 'X-Invite': INVITE, 'X-Device-Token': 'f'.repeat(32) }),
      env
    );
    expect(wrong.status).toBe(403);
    const ok = await handleRequest(
      post('/subscribe', profile(), { 'X-Invite': INVITE, 'X-Device-Token': first.token }),
      env
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).token).toBeUndefined();
  });

  it('a migrated record without a token can be claimed once by a valid invite', async () => {
    const { env, kv } = setup();
    const legacy = { ...profile(), updatedAt: 'x' };
    kv.data.set('sub:ios_test_device_1', JSON.stringify(legacy));
    const res: any = await (
      await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env)
    ).json();
    expect(res.token).toBeTruthy();
    const again = await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    expect(again.status).toBe(403);
  });

  it('keeps one record per physical endpoint', async () => {
    const { env, kv } = setup();
    await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    await handleRequest(
      post('/subscribe', profile({ id: 'ios_test_device_2' }), { 'X-Invite': INVITE }),
      env
    );
    const subs = [...kv.data.keys()].filter((k) => k.startsWith('sub:'));
    expect(subs).toEqual(['sub:ios_test_device_2']);
  });

  it('refuses endpoints outside the known push services (no arbitrary URLs)', async () => {
    const { env } = setup();
    for (const endpoint of [
      'https://evil.example/push',
      'http://web.push.apple.com/x',
      'https://web.push.apple.com.evil.example/x',
      'https://127.0.0.1/x',
      'https://user:pw@web.push.apple.com/x',
      'https://web.push.apple.com:8443/x',
    ]) {
      const p = profile({ subscription: { endpoint, keys: { p256dh: P256DH, auth: AUTH } } });
      expect(
        (await handleRequest(post('/subscribe', p, { 'X-Invite': INVITE }), env)).status
      ).toBe(400);
    }
  });

  it('validates the rest of the payload', () => {
    expect(sanitizeProfile(profile({ id: 'short' }))).toBeNull();
    expect(sanitizeProfile(profile({ addresses: [{ id: 'a', region: 'xx', group: '1.1' }] }))).toBeNull();
    expect(sanitizeProfile(profile({ addresses: [{ id: 'a', region: 'kem', group: 'bad' }] }))).toBeNull();
    expect(sanitizeProfile(profile({ addresses: new Array(11).fill(profile().addresses[0]) }))).toBeNull();
    expect(sanitizeProfile(profile())!.addresses[0]).toMatchObject({ street: '', house: '', city: '' });
  });

  it('internal endpoints need the shared secret and hide token hashes', async () => {
    const { env } = setup();
    await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    expect((await handleRequest(internalGet('/internal/subscribers', 'nope'), env)).status).toBe(401);
    expect(
      (await handleRequest(new Request('https://subs.test/internal/subscribers'), env)).status
    ).toBe(401);
    const res = await handleRequest(internalGet('/internal/subscribers'), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const body: any = await res.json();
    expect(body.subscribers).toHaveLength(1);
    expect(body.subscribers[0].tokenHash).toBeUndefined();
    expect(body.subscribers[0].subscription.endpoint).toContain('web.push.apple.com');
  });

  it('a too-short or missing SUBS_SECRET disables the internal endpoints', async () => {
    const { env } = setup();
    env.SUBS_SECRET = 'short';
    expect((await handleRequest(internalGet('/internal/subscribers', 'short'), env)).status).toBe(401);
    env.SUBS_SECRET = undefined;
    expect((await handleRequest(internalGet('/internal/subscribers', ''), env)).status).toBe(401);
  });

  it('removes a dead endpoint on request of the Action', async () => {
    const { env, kv } = setup();
    await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    const res: any = await (
      await handleRequest(
        new Request('https://subs.test/internal/remove', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SECRET}` },
          body: JSON.stringify({ endpoint: 'https://web.push.apple.com/QWERTY1' }),
        }),
        env
      )
    ).json();
    expect(res.removed).toBe(true);
    expect(kv.data.size).toBe(0);
  });

  it('unsubscribe needs invite and the device token', async () => {
    const { env, kv } = setup();
    const first: any = await (
      await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env)
    ).json();
    const denied = await handleRequest(
      post('/unsubscribe', { id: 'ios_test_device_1' }, { 'X-Invite': INVITE }),
      env
    );
    expect(denied.status).toBe(403);
    expect(kv.data.size).toBe(2);
    const ok = await handleRequest(
      post('/unsubscribe', { id: 'ios_test_device_1' }, { 'X-Invite': INVITE, 'X-Device-Token': first.token }),
      env
    );
    expect(ok.status).toBe(200);
    expect(kv.data.size).toBe(0);
  });
});

describe('purgeStale', () => {
  it('removes subscriptions not refreshed for 30+ days, keeps fresh ones and unjudgeable ones', async () => {
    const { purgeStale } = await import('../cloudflare/subs/src/handler');
    const { env, kv } = setup();
    await handleRequest(post('/subscribe', profile(), { 'X-Invite': INVITE }), env);
    await handleRequest(
      post(
        '/subscribe',
        profile({
          id: 'ios_test_device_2',
          subscription: { endpoint: 'https://web.push.apple.com/OTHER2', keys: { p256dh: P256DH, auth: AUTH } },
        }),
        { 'X-Invite': INVITE }
      ),
      env
    );
    const old = JSON.parse(kv.data.get('sub:ios_test_device_2')!);
    old.updatedAt = new Date(Date.now() - 31 * 86_400_000).toISOString();
    kv.data.set('sub:ios_test_device_2', JSON.stringify(old));
    kv.data.set('sub:ios_nodate', JSON.stringify({ id: 'ios_nodate' }));

    expect(await purgeStale(env)).toBe(1);
    expect(kv.data.has('sub:ios_test_device_2')).toBe(false);
    expect([...kv.data.keys()].filter((k) => k.startsWith('ep:'))).toHaveLength(1);
    expect(kv.data.has('sub:ios_test_device_1')).toBe(true);
    expect(kv.data.has('sub:ios_nodate')).toBe(true);
  });
});
