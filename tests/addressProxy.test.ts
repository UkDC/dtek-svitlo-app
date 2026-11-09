import { describe, it, expect } from 'vitest';
import { handleRequest, YASNO_BASE } from '../cloudflare/address/src/handler';

const ORIGIN = 'https://ukdc.github.io';
const req = (path: string, init: RequestInit = {}) =>
  new Request(`https://svitlo-address.example.workers.dev${path}`, init);

function mockUpstream(map: Record<string, unknown>) {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    const rel = url.replace(YASNO_BASE, '');
    if (rel in map) {
      return new Response(JSON.stringify(map[rel]), { status: 200 });
    }
    return new Response('nope', { status: 404 });
  };
  return { fetchImpl, calls };
}

describe('address proxy (YASNO, Kyiv only)', () => {
  it('forwards /streets with fixed Kyiv ids and CORS for the Pages origin', async () => {
    const { fetchImpl, calls } = mockUpstream({
      '/streets?regionId=25&dsoId=902&query=%D0%A5%D1%80%D0%B5': [{ id: 1, value: 'вул. Хрещатик' }],
    });
    const res = await handleRequest(req('/streets?query=Хре', { headers: { Origin: ORIGIN } }), fetchImpl);
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(await res.json()).toEqual([{ id: 1, value: 'вул. Хрещатик' }]);
    expect(calls).toHaveLength(1);
  });

  it('rejects foreign origins and non-GET methods', async () => {
    const { fetchImpl, calls } = mockUpstream({});
    const bad = await handleRequest(req('/streets?query=ab', { headers: { Origin: 'https://evil.example' } }), fetchImpl);
    expect(bad.status).toBe(403);
    const post = await handleRequest(req('/streets?query=ab', { method: 'POST' }), fetchImpl);
    expect(post.status).toBe(405);
    expect(calls).toHaveLength(0);
  });

  it('validates parameters and never forwards arbitrary paths', async () => {
    const { fetchImpl, calls } = mockUpstream({});
    for (const p of [
      '/streets?query=a',
      '/streets?query=' + 'x'.repeat(41),
      '/houses?streetId=abc',
      '/houses?streetId=1&query=' + 'x'.repeat(21),
      '/group?streetId=1',
      '/group?streetId=1&houseId=../../x',
    ]) {
      const res = await handleRequest(req(p), fetchImpl);
      expect(res.status, p).toBe(400);
    }
    const nf = await handleRequest(req('/planned-outages'), fetchImpl);
    expect(nf.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('maps upstream failure to 502 instead of leaking details', async () => {
    const { fetchImpl } = mockUpstream({});
    const res = await handleRequest(req('/group?streetId=1&houseId=2'), fetchImpl);
    expect(res.status).toBe(502);
  });

  it('/diag reports the whole street -> house -> group chain', async () => {
    const { fetchImpl } = mockUpstream({
      '/streets?regionId=25&dsoId=902&query=%D0%A5%D1%80%D0%B5%D1%89': [{ id: 7, value: 'вул. Хрещатик' }],
      '/houses?regionId=25&dsoId=902&streetId=7&query=1': [{ id: 70, value: '1' }],
      '/group?regionId=25&dsoId=902&streetId=7&houseId=70': { group: 36, subgroup: 1 },
    });
    const res = await handleRequest(req('/diag'), fetchImpl);
    const body: any = await res.json();
    expect(body.streets).toEqual({ status: 200, count: 1 });
    expect(body.group.sample).toEqual({ group: 36, subgroup: 1 });
    // DTEK pages are not in the mock -> reported as status 404 flags, never an exception
    expect(body.dtekKem.status).toBe(404);
    expect(body.dtekKrem.hasSchedule).toBe(false);
  });
});
