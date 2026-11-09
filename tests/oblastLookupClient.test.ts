import { describe, expect, it, vi } from 'vitest';
import { lookupOblastGroup, oblastFailureText } from '../src/services/oblastLookup';

const q = { city: ' м. Бориспіль ', street: 'Київський Шлях', house: '9' };
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function setup(responses: Array<Response | Error>) {
  const queue = [...responses];
  const calls: Array<[string, RequestInit | undefined]> = [];
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push([url, init]);
    const next = queue.shift();
    if (!next) throw new Error('unexpected extra request');
    if (next instanceof Error) throw next;
    return next;
  });
  let t = 0;
  return {
    calls,
    opts: {
      invite: ' CODE ',
      baseUrl: 'https://w.example/',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms: number) => {
        t += ms;
      },
      now: () => t,
      pollIntervalMs: 3000,
      totalTimeoutMs: 150_000,
    },
  };
}

describe('lookupOblastGroup', () => {
  it('starts, polls until done and sends trimmed data with the invite header', async () => {
    const states: string[] = [];
    const { opts, calls } = setup([
      json({ id: 'a'.repeat(32) }),
      json({ state: 'queued' }),
      json({ state: 'running' }),
      json({ state: 'done', group: '5.2' }),
    ]);
    const r = await lookupOblastGroup(q, { ...opts, onState: (s) => states.push(s) });
    expect(r).toEqual({ ok: true, group: '5.2' });
    expect(states).toEqual(['queued', 'running']);
    const [url, init] = calls[0];
    expect(url).toBe('https://w.example/start');
    expect((init!.headers as Record<string, string>)['X-Invite']).toBe('CODE');
    expect(JSON.parse(init!.body as string)).toEqual({ city: 'м. Бориспіль', street: 'Київський Шлях', house: '9' });
    // the address never goes into the poll URL
    expect(calls[1][0]).toBe(`https://w.example/result?id=${'a'.repeat(32)}`);
  });

  it('maps start errors', async () => {
    expect(await lookupOblastGroup(q, setup([json({}, 401)]).opts)).toEqual({ ok: false, reason: 'invite' });
    expect(await lookupOblastGroup(q, setup([json({}, 429)]).opts)).toEqual({ ok: false, reason: 'limit' });
    expect(await lookupOblastGroup(q, setup([json({}, 502)]).opts)).toEqual({ ok: false, reason: 'service' });
    expect(await lookupOblastGroup(q, setup([json({ nope: 1 })]).opts)).toEqual({ ok: false, reason: 'service' });
    expect(await lookupOblastGroup(q, setup([new TypeError('offline')]).opts)).toEqual({ ok: false, reason: 'network' });
  });

  it('returns server failure reasons with candidates; unknown reasons become service', async () => {
    const a = setup([json({ id: 'b'.repeat(32) }), json({ state: 'failed', reason: 'street_ambiguous', candidates: ['вул. А', 'пров. А', 5] })]);
    expect(await lookupOblastGroup(q, a.opts)).toEqual({ ok: false, reason: 'street_ambiguous', candidates: ['вул. А', 'пров. А'] });
    const b = setup([json({ id: 'b'.repeat(32) }), json({ state: 'failed', reason: 'mystery' })]);
    expect(await lookupOblastGroup(q, b.opts)).toEqual({ ok: false, reason: 'service' });
  });

  it('survives transient poll failures but gives up after four in a row', async () => {
    const ok = setup([json({ id: 'c'.repeat(32) }), new TypeError('x'), json({}, 500), json({ state: 'done', group: '1.1' })]);
    expect(await lookupOblastGroup(q, ok.opts)).toEqual({ ok: true, group: '1.1' });
    const bad = setup([json({ id: 'c'.repeat(32) }), new TypeError('x'), new TypeError('x'), new TypeError('x'), new TypeError('x')]);
    expect(await lookupOblastGroup(q, bad.opts)).toEqual({ ok: false, reason: 'network' });
  });

  it('keeps polling for the full window (>= 120 s), then times out', async () => {
    const polls = Array.from({ length: 60 }, () => json({ state: 'running' }));
    const { opts, calls } = setup([json({ id: 'd'.repeat(32) }), ...polls]);
    expect(await lookupOblastGroup(q, opts)).toEqual({ ok: false, reason: 'timeout' });
    expect(calls.length - 1).toBe(50); // 150 s / 3 s
  });

  it('stops when aborted', async () => {
    const ctl = new AbortController();
    const { opts } = setup([json({ id: 'e'.repeat(32) }), json({ state: 'running' })]);
    const r = await lookupOblastGroup(q, {
      ...opts,
      signal: ctl.signal,
      sleep: async () => ctl.abort(),
    });
    expect(r).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('has a message for every user-visible reason', () => {
    for (const r of ['city_not_found', 'city_ambiguous', 'street_not_found', 'street_ambiguous', 'house_not_found',
      'group_unknown', 'group_ambiguous', 'blocked', 'parse', 'timeout', 'expired', 'invite', 'limit', 'service', 'network'] as const) {
      expect(oblastFailureText(r).length).toBeGreaterThan(10);
    }
    expect(oblastFailureText('cancelled')).toBe('');
  });
});
