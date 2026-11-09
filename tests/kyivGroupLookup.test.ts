import { afterEach, describe, expect, it, vi } from 'vitest';
import { lookupHouseGroup } from '../src/services/clientScheduleApi';

function stubProxy(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    const path = String(url).replace(/^https:\/\/[^/]+/, '');
    calls.push(path);
    if (path in routes) return new Response(JSON.stringify(routes[path]), { status: 200 });
    return new Response('{}', { status: 502 });
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

// Unique street names per test: proxy responses are cached in-memory for the session.
describe('Kyiv house -> group via YASNO proxy', () => {
  it('sends the street probe capitalised even if the user typed lowercase', async () => {
    const calls = stubProxy({});
    await lookupHouseGroup('kem', 'м. Київ', 'вул. регістрова', undefined, '1');
    expect(calls.map(decodeURIComponent)).toContain('/streets?query=Регістрова');
  });

  it('detects the real group of the exact house', async () => {
    stubProxy({
      '/streets?query=%D0%9F%D1%80%D0%BE%D0%B1%D0%BD%D0%B0': [{ id: 11, value: 'вул. Пробна' }],
      '/houses?streetId=11&query=5': [
        { id: 501, value: '5' },
        { id: 502, value: '5А' },
      ],
      '/group?streetId=11&houseId=501': { group: 13, subgroup: 1 },
    });
    const r = await lookupHouseGroup('kem', 'м. Київ', 'вул. Пробна', undefined, '5');
    expect(r.detectedGroup).toBe('13.1');
    expect(r.houses.map((h) => h.house)).toEqual(['5', '5А']);
  });

  it('ignores a stale street id that YASNO no longer returns for this name', async () => {
    const calls = stubProxy({
      '/streets?query=%D0%A2%D0%B5%D1%81%D1%82%D0%BE%D0%B2%D0%B0': [{ id: 22, value: 'вул. Тестова' }],
      '/houses?streetId=22&query=1': [{ id: 601, value: '1' }],
      '/group?streetId=22&houseId=601': { group: 4, subgroup: 2 },
    });
    const r = await lookupHouseGroup('kem', 'м. Київ', 'вул. Тестова', 999 /* stale */, '1');
    expect(r.detectedGroup).toBe('4.2');
    expect(calls.some((c) => c.includes('streetId=999'))).toBe(false);
  });

  it('never guesses: unknown house, ambiguous street, or proxy failure give no group', async () => {
    stubProxy({
      '/streets?query=%D0%9D%D0%B5%D0%B2%D1%96%D0%B4%D0%BE%D0%BC%D0%B0': [{ id: 33, value: 'вул. Невідома' }],
      '/houses?streetId=33&query=777': [{ id: 701, value: '1' }],
    });
    const unknownHouse = await lookupHouseGroup('kem', 'м. Київ', 'вул. Невідома', undefined, '777');
    expect(unknownHouse.detectedGroup).toBeUndefined();

    stubProxy({
      '/streets?query=%D0%A1%D0%BF%D1%96%D1%80%D0%BD%D0%B0': [
        { id: 44, value: 'вул. Спірна' },
        { id: 45, value: 'пров. Спірна' },
      ],
    });
    const ambiguous = await lookupHouseGroup('kem', 'м. Київ', 'Спірна', undefined, '1');
    expect(ambiguous.detectedGroup).toBeUndefined();

    stubProxy({});
    const down = await lookupHouseGroup('kem', 'м. Київ', 'вул. Недоступна', undefined, '1');
    expect(down.detectedGroup).toBeUndefined();
  });

  it('Kyiv oblast never gets an automatic group', async () => {
    const calls = stubProxy({});
    const r = await lookupHouseGroup('krem', 'с. Приклад', 'вул. Центральна', undefined, '1');
    expect(r.detectedGroup).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
