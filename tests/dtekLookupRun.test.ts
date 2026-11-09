import { describe, expect, it } from 'vitest';
import { parseJob, runLookup } from '../scripts/dtek/lookupRun.ts';
import type { DtekTransport } from '../scripts/dtek/lookupRun.ts';

const streets = {
  'м. Бориспіль': ['вул. Київський Шлях', 'вул. Лесі Українки', 'пров. Лесі Українки'],
  'с. Дудки': ['вул. Центральна'],
  'м. Буча': [],
  'с. Буча': [],
};
const realPage =
  `<meta name="csrf-token" content="tok">` +
  `<script>DisconSchedule.streets = ${JSON.stringify(streets)};</script>` +
  ' '.repeat(25000);

const houses = {
  '9': { sub_type_reason: ['GPV1.1'] },
  '24Б': { sub_type_reason: ['GPV2.1'] },
  '5-А': { sub_type_reason: ['GPV3.2'] },
  '1/кв.61': { sub_type_reason: ['GPV4.1'] },
  '40': { sub_type_reason: ['GPV5.1', 'GPV6.1'] },
};

function fake(over: Partial<DtekTransport> = {}) {
  const calls: Array<[string, string, string]> = [];
  const t: DtekTransport = {
    page: async () => ({ status: 200, bytes: realPage.length, html: realPage }),
    homes: async (csrf, city, street) => {
      calls.push([csrf, city, street]);
      return { status: 200, bytes: 500, json: { result: true, data: houses } };
    },
    ...over,
  };
  return { t, calls };
}

const job = (house: string, city = 'Бориспіль', street = 'вулиця Київський Шлях') => ({ city, street, house });

describe('parseJob', () => {
  it('accepts a well-formed job and rejects the rest', () => {
    expect(parseJob({ city: 'a', street: 'b', house: 'c' })).toEqual({ city: 'a', street: 'b', house: 'c' });
    expect(parseJob({ city: 'a', street: 'b' })).toBeUndefined();
    expect(parseJob({ city: 'a', street: 'b', house: ' ' })).toBeUndefined();
    expect(parseJob({ city: 'a', street: 'b', house: 'x'.repeat(121) })).toBeUndefined();
    expect(parseJob({ city: 'a\n', street: 'b', house: 'c' })).toBeUndefined();
    expect(parseJob(null)).toBeUndefined();
  });
});

describe('runLookup', () => {
  it('resolves a group and sends DTEK its own spelling', async () => {
    const { t, calls } = fake();
    expect(await runLookup(job('9'), t)).toEqual({ ok: true, group: '1.1' });
    expect(calls).toEqual([['tok', 'м. Бориспіль', 'вул. Київський Шлях']]);
  });

  it.each([
    ['24б', '2.1'],
    ['24Б', '2.1'],
    ['5а', '3.2'],
    ['1', '4.1'],
  ])('house %s -> %s', async (house, group) => {
    expect(await runLookup(job(house), fake().t)).toEqual({ ok: true, group });
  });

  it('reports blocked for Imperva stubs (212 / 958 bytes) and non-200', async () => {
    for (const bytes of [212, 958]) {
      const { t } = fake({ page: async () => ({ status: 200, bytes, html: 'x'.repeat(bytes) }) });
      expect(await runLookup(job('9'), t)).toEqual({ ok: false, reason: 'blocked' });
    }
    const { t } = fake({ page: async () => ({ status: 403, bytes: 100000, html: realPage }) });
    expect(await runLookup(job('9'), t)).toEqual({ ok: false, reason: 'blocked' });
  });

  it('reports parse when the page layout changed', async () => {
    const html = '<html>' + ' '.repeat(25000) + '</html>';
    const { t } = fake({ page: async () => ({ status: 200, bytes: html.length, html }) });
    expect(await runLookup(job('9'), t)).toEqual({ ok: false, reason: 'parse' });
  });

  it('city / street failures never call the ajax endpoint', async () => {
    const a = fake();
    expect(await runLookup(job('9', 'Нікуди'), a.t)).toEqual({ ok: false, reason: 'city_not_found' });
    expect(await runLookup(job('9', 'Буча'), a.t)).toMatchObject({
      ok: false,
      reason: 'city_ambiguous',
      candidates: expect.arrayContaining(['м. Буча', 'с. Буча']),
    });
    expect(await runLookup(job('9', 'Бориспіль', 'Невідома'), a.t)).toEqual({
      ok: false,
      reason: 'street_not_found',
    });
    expect(await runLookup(job('9', 'Бориспіль', 'Лесі Українки'), a.t)).toMatchObject({
      ok: false,
      reason: 'street_ambiguous',
      candidates: ['вул. Лесі Українки', 'пров. Лесі Українки'],
    });
    expect(a.calls).toHaveLength(0);
  });

  it('house failures', async () => {
    expect(await runLookup(job('77'), fake().t)).toEqual({ ok: false, reason: 'house_not_found' });
    expect(await runLookup(job('40'), fake().t)).toEqual({ ok: false, reason: 'group_ambiguous' });
  });

  it('ajax failures', async () => {
    const mk = (r: { status: number; bytes: number; json?: unknown }) => fake({ homes: async () => r }).t;
    expect(await runLookup(job('9'), mk({ status: 403, bytes: 212 }))).toEqual({ ok: false, reason: 'blocked' });
    expect(await runLookup(job('9'), mk({ status: 500, bytes: 3000 }))).toEqual({ ok: false, reason: 'parse' });
    expect(await runLookup(job('9'), mk({ status: 200, bytes: 50, json: { result: false } }))).toEqual({
      ok: false,
      reason: 'parse',
    });
    expect(await runLookup(job('9'), mk({ status: 200, bytes: 50, json: { data: {} } }))).toEqual({
      ok: false,
      reason: 'house_not_found',
    });
  });
});
