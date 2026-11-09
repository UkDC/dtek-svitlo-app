import { describe, expect, it } from 'vitest';
import {
  extractCsrf,
  extractStreetsMap,
  findCity,
  findStreet,
  groupsOfEntry,
  housesOf,
  looksLikeRealPage,
  normalizeHouse,
  resolveHouse,
} from '../scripts/dtek/lookupCore.ts';

const entry = (...reasons: string[]) => ({ sub_type_reason: reasons });

describe('page detection', () => {
  it('rejects Imperva stubs and non-200', () => {
    expect(looksLikeRealPage(200, 212)).toBe(false);
    expect(looksLikeRealPage(200, 958)).toBe(false);
    expect(looksLikeRealPage(403, 1_260_000)).toBe(false);
    expect(looksLikeRealPage(200, 1_260_000)).toBe(true);
  });

  it('extracts the csrf token', () => {
    expect(extractCsrf('<head><meta name="csrf-token" content="abc123=="></head>')).toBe('abc123==');
    expect(extractCsrf('<html></html>')).toBeUndefined();
  });
});

describe('streets map extraction', () => {
  const html = `<script>
    DisconSchedule.fact = {"x": "}"};
    DisconSchedule.streets = {"м. Бориспіль":["вул. Київський Шлях","вул. \\"Гоголя\\" {1}"],"с. Дудки":[]};
    DisconSchedule.other = 1;
  </script>`;

  it('parses a balanced object, ignoring braces inside strings', () => {
    const m = extractStreetsMap(html);
    expect(m).toBeDefined();
    expect(Object.keys(m!)).toEqual(['м. Бориспіль', 'с. Дудки']);
    expect(m!['м. Бориспіль']).toHaveLength(2);
  });

  it('returns undefined when missing or malformed', () => {
    expect(extractStreetsMap('<html/>')).toBeUndefined();
    expect(extractStreetsMap('DisconSchedule.streets = {"a":[')).toBeUndefined();
    expect(extractStreetsMap('DisconSchedule.streets = []')).toBeUndefined();
  });
});

describe('city and street matching', () => {
  const map = {
    'м. Бориспіль': ['вул. Київський Шлях'],
    'с. Дудки': [],
    'с. Дубове': [],
    'м. Буча': [],
    'с. Буча': [],
    'смт Баришівка': [],
  };

  it('matches ignoring type words, case, punctuation', () => {
    expect(findCity(map, 'Бориспіль')).toEqual({ kind: 'ok', value: 'м. Бориспіль' });
    expect(findCity(map, 'місто Бориспіль')).toEqual({ kind: 'ok', value: 'м. Бориспіль' });
    expect(findCity(map, 'смт. Баришівка')).toEqual({ kind: 'ok', value: 'смт Баришівка' });
  });

  it('does not match by prefix or similarity', () => {
    expect(findCity(map, 'Дуд')).toEqual({ kind: 'none' });
    expect(findCity(map, 'Бориспол')).toEqual({ kind: 'none' });
    expect(findCity(map, '')).toEqual({ kind: 'none' });
  });

  it('prefers the typed settlement type, otherwise reports ambiguity', () => {
    expect(findCity(map, 'с. Буча')).toEqual({ kind: 'ok', value: 'с. Буча' });
    const r = findCity(map, 'Буча');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.sort()).toEqual(['м. Буча', 'с. Буча']);
  });

  it('matches streets regardless of word order and type spelling', () => {
    const streets = ['вул. Київський Шлях', 'пров. Київський', 'вул. Лесі Українки', 'вул. Українки'];
    expect(findStreet(streets, 'Київський Шлях вулиця')).toEqual({
      kind: 'ok',
      value: 'вул. Київський Шлях',
    });
    expect(findStreet(streets, 'вулиця Лесі Українки')).toEqual({
      kind: 'ok',
      value: 'вул. Лесі Українки',
    });
    expect(findStreet(streets, 'Київський')).toEqual({ kind: 'ok', value: 'пров. Київський' });
    expect(findStreet(streets, 'Центральна')).toEqual({ kind: 'none' });
  });

  it('caps candidates', () => {
    const streets = Array.from({ length: 20 }, (_, i) => `${i % 2 ? 'вул.' : 'пров.'} Мирна ${i}`)
      .map(() => 'x');
    expect(findStreet(streets, 'Мирна').kind).toBe('none');
    const many = Array.from({ length: 20 }, () => 'вул. Мирна');
    const r = findStreet(many, 'Мирна');
    expect(r.kind).toBe('ambiguous');
    if (r.kind === 'ambiguous') expect(r.candidates.length).toBeLessThanOrEqual(8);
  });
});

describe('house normalisation', () => {
  it.each([
    ['24Б', '24б'],
    ['5-А', '5а'],
    ['5A', '5а'],
    [' буд. 12 / 3 ', '12/3'],
    ['12\\3', '12/3'],
    ['1/кв.61', '1/кв.61'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeHouse(input)).toBe(expected);
  });
});

describe('group extraction', () => {
  it('maps GPV codes and drops non-schedule reasons', () => {
    expect(groupsOfEntry(entry('GPV5.2'))).toEqual(['5.2']);
    expect(groupsOfEntry(entry('GPV5.2', 'GPV5.2'))).toEqual(['5.2']);
    expect(groupsOfEntry(entry('GPV5.2', 'Аварійні ремонтні роботи'))).toEqual(['5.2']);
    expect(groupsOfEntry(entry('GPV5.2', 'GPV3.1')).sort()).toEqual(['3.1', '5.2']);
  });

  it('rejects groups outside the oblast range and malformed values', () => {
    expect(groupsOfEntry(entry('GPV7.1'))).toEqual([]);
    expect(groupsOfEntry(entry('GPV1.3'))).toEqual([]);
    expect(groupsOfEntry(entry('GPV12.1'))).toEqual([]);
    expect(groupsOfEntry({ sub_type_reason: 'GPV1.1' })).toEqual([]);
    expect(groupsOfEntry(undefined)).toEqual([]);
  });
});

describe('house resolution', () => {
  const houses = {
    '9': entry('GPV1.1'),
    '24Б': entry('GPV2.1'),
    '5-А': entry('GPV3.2'),
    '12/к.3': entry('GPV4.1'),
    '12/к.4': entry('GPV4.1'),
    '30': entry('GPV1.2'),
    '30/кв.1': entry('GPV2.2'),
    '40/1': entry('GPV5.1'),
    '40/2': entry('GPV6.1'),
    '50': entry('Аварійні ремонтні роботи'),
    '60': entry('GPV1.1', 'GPV1.2'),
  };

  it('matches an exact normalised key', () => {
    expect(resolveHouse(houses, '9')).toEqual({ ok: true, group: '1.1' });
    expect(resolveHouse(houses, '24б')).toEqual({ ok: true, group: '2.1' });
    expect(resolveHouse(houses, '5а')).toEqual({ ok: true, group: '3.2' });
    expect(resolveHouse(houses, '5A')).toEqual({ ok: true, group: '3.2' });
  });

  it('an exact key wins over slash-suffixed siblings', () => {
    expect(resolveHouse(houses, '30')).toEqual({ ok: true, group: '1.2' });
  });

  it('accepts slash-suffixed keys only when they all agree', () => {
    expect(resolveHouse(houses, '12')).toEqual({ ok: true, group: '4.1' });
    expect(resolveHouse(houses, '40')).toEqual({ ok: false, reason: 'group_ambiguous' });
  });

  it('never matches a different building', () => {
    expect(resolveHouse(houses, '24')).toEqual({ ok: false, reason: 'house_not_found' });
    expect(resolveHouse(houses, '2')).toEqual({ ok: false, reason: 'house_not_found' });
    expect(resolveHouse(houses, '')).toEqual({ ok: false, reason: 'house_not_found' });
  });

  it('reports unknown and ambiguous groups', () => {
    expect(resolveHouse(houses, '50')).toEqual({ ok: false, reason: 'group_unknown' });
    expect(resolveHouse(houses, '60')).toEqual({ ok: false, reason: 'group_ambiguous' });
  });

  it('extracts houses from an ajax answer', () => {
    expect(housesOf({ result: true, data: { '1': entry('GPV1.1') } })).toBeDefined();
    expect(housesOf({ data: [] })).toBeUndefined();
    expect(housesOf(null)).toBeUndefined();
  });
});
