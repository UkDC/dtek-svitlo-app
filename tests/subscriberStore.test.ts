import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadSubscribers,
  removeSubscriberByEndpoint,
} from '../server/services/notificationScheduler';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('server subscriber store', () => {
  it('reads subscribers from the private store with the shared secret', async () => {
    vi.stubEnv('SUBS_API_URL', 'https://subs.example/');
    vi.stubEnv('SUBS_SECRET', 's'.repeat(40));
    const seen: Array<{ url: string; auth: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: any) => {
      seen.push({ url, auth: init.headers.Authorization });
      return new Response(JSON.stringify({ subscribers: [{ id: 'x', addresses: [] }] }), { status: 200 });
    });
    const list = await loadSubscribers();
    expect(list).toHaveLength(1);
    expect(seen[0].url).toBe('https://subs.example/internal/subscribers');
    expect(seen[0].auth).toBe(`Bearer ${'s'.repeat(40)}`);
  });

  it('fails loudly when the store is down (an outage must not look like "no subscribers")', async () => {
    vi.stubEnv('SUBS_API_URL', 'https://subs.example');
    vi.stubEnv('SUBS_SECRET', 's'.repeat(40));
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 500 }));
    await expect(loadSubscribers()).rejects.toThrow(/HTTP 500/);
  });

  it('refuses to run on GitHub Actions without the store configured', async () => {
    vi.stubEnv('GITHUB_ACTIONS', 'true');
    vi.stubEnv('SUBS_API_URL', '');
    vi.stubEnv('SUBS_SECRET', '');
    await expect(loadSubscribers()).rejects.toThrow(/not configured/);
  });

  it('asks the store to drop a dead endpoint', async () => {
    vi.stubEnv('SUBS_API_URL', 'https://subs.example');
    vi.stubEnv('SUBS_SECRET', 's'.repeat(40));
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (_u: string, init: any) => {
      bodies.push(String(init.body));
      return new Response('{}', { status: 200 });
    });
    await removeSubscriberByEndpoint('https://web.push.apple.com/dead');
    expect(JSON.parse(bodies[0])).toEqual({ endpoint: 'https://web.push.apple.com/dead' });
  });
});
