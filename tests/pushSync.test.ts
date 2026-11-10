import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  disablePush,
  getDeviceSubscriberId,
  purgeLegacyGitHubToken,
  saveInviteCode,
  syncSubscriberState,
} from '../src/services/pushSyncService';

const quiet = { enabled: false, start: '23:00', end: '07:00' };
const addresses: any[] = [
  {
    id: 'a1', label: 'Дім', icon: '🏠', region: 'kem', city: 'м. Київ', street: 'вул. Таємна',
    house: '7', group: '13.1', notifyBeforeOff: true, notifyBeforeOn: true, notifyOnChange: true,
    createdAt: '2026-01-01T00:00:00Z',
  },
];
const sub: any = {
  toJSON: () => ({
    endpoint: 'https://web.push.apple.com/abc',
    keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) },
  }),
};

let store: Map<string, string>;
let calls: Array<{ url: string; init: any }>;

beforeEach(() => {
  store = new Map();
  calls = [];
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('window', {
    location: { hash: '', pathname: '/', search: '' },
    history: { replaceState: () => {} },
  });
});
afterEach(() => vi.unstubAllGlobals());

function stubFetch(handler: (url: string, init: any) => Response) {
  vi.stubGlobal('fetch', async (url: string, init: any) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  });
}
const subsCalls = () => calls.filter((c) => c.url.endsWith('/subscribe') && c.url.startsWith('https://'));

describe('push subscription sync (private store)', () => {
  it('does nothing in the cloud without an invite code', async () => {
    stubFetch(() => new Response('{}', { status: 404 }));
    const r = await syncSubscriberState(addresses, quiet, sub);
    expect(r.syncedCloud).toBe(false);
    expect(r.cloudError).toBe('no-invite');
    expect(subsCalls()).toHaveLength(0);
  });

  it('sends only the whitelisted address fields, never street/house', async () => {
    saveInviteCode('AAAA-BBBB-CCCC-DDDD');
    stubFetch(() => new Response(JSON.stringify({ ok: true, token: 't'.repeat(32) }), { status: 200 }));
    const r = await syncSubscriberState(addresses, quiet, sub);
    expect(r.syncedCloud).toBe(true);
    const body = String(subsCalls()[0].init.body);
    expect(body).not.toContain('Таємна');
    expect(body).not.toContain('"house":"7"');
    expect(subsCalls()[0].init.headers['X-Invite']).toBe('AAAA-BBBB-CCCC-DDDD');
    expect(store.get('svitlo_device_write_token')).toBe('t'.repeat(32));
  });

  it('reports a wrong invite code', async () => {
    saveInviteCode('WRONG');
    stubFetch(() => new Response('{}', { status: 401 }));
    const r = await syncSubscriberState(addresses, quiet, sub);
    expect(r.cloudError).toBe('invite');
  });

  it('starts over with a fresh device id when the write token is rejected', async () => {
    saveInviteCode('AAAA-BBBB-CCCC-DDDD');
    store.set('svitlo_device_subscriber_id', 'ios_old_device_1');
    store.set('svitlo_device_write_token', 'stale');
    let n = 0;
    stubFetch(() =>
      ++n === 1
        ? new Response('{}', { status: 403 })
        : new Response(JSON.stringify({ ok: true, token: 'n'.repeat(32) }), { status: 200 })
    );
    const r = await syncSubscriberState(addresses, quiet, sub);
    expect(r.syncedCloud).toBe(true);
    const ids = subsCalls().map((c) => JSON.parse(c.init.body).id);
    expect(ids[0]).toBe('ios_old_device_1');
    expect(ids[1]).not.toBe('ios_old_device_1');
  });

  it('removes a leftover GitHub token from older builds', () => {
    store.set('svitlo_gh_cloud_config_v1', '{"token":"github_pat_x"}');
    expect(purgeLegacyGitHubToken()).toBe(true);
    expect(store.has('svitlo_gh_cloud_config_v1')).toBe(false);
  });
});


describe('disablePush', () => {
  const unsub = vi.fn(async () => true);
  beforeEach(() => {
    unsub.mockClear();
    vi.stubGlobal('navigator', {
      serviceWorker: {
        getRegistration: async () => ({ pushManager: { getSubscription: async () => ({ unsubscribe: unsub }) } }),
      },
    });
  });

  it('removes the cloud record with the device token, then the local subscription', async () => {
    saveInviteCode('AAAA-BBBB-CCCC-DDDD');
    store.set('svitlo_device_write_token', 'tok');
    const id = getDeviceSubscriberId();
    stubFetch(() => new Response('{"ok":true}', { status: 200 }));
    const r = await disablePush();
    expect(r).toEqual({ ok: true, cloudRemoved: true });
    const call = calls.find((c) => c.url.endsWith('/unsubscribe'))!;
    expect(call.init.headers['X-Device-Token']).toBe('tok');
    expect(JSON.parse(call.init.body)).toEqual({ id });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(store.has('svitlo_device_write_token')).toBe(false);
  });

  it('still drops the local subscription when the cloud is unreachable, keeping the token', async () => {
    saveInviteCode('AAAA-BBBB-CCCC-DDDD');
    store.set('svitlo_device_write_token', 'tok');
    vi.stubGlobal('fetch', async () => {
      throw new Error('offline');
    });
    const r = await disablePush();
    expect(r).toEqual({ ok: true, cloudRemoved: false });
    expect(unsub).toHaveBeenCalledTimes(1);
    expect(store.get('svitlo_device_write_token')).toBe('tok');
  });

  it('skips the cloud call for a device that never registered', async () => {
    stubFetch(() => new Response('{}', { status: 200 }));
    const r = await disablePush();
    expect(r.cloudRemoved).toBe(false);
    expect(calls).toHaveLength(0);
    expect(unsub).toHaveBeenCalledTimes(1);
  });
});
