import { describe, expect, it } from 'vitest';
import {
  cleanSettlementNameForSort,
  cleanStreetNameForSort,
  lookupHouseGroup,
  searchSettlements,
  searchStreets,
} from '../src/services/clientScheduleApi';

describe('Address search and alphabetical sorting', () => {
  it('correctly strips prefixes for clean Ukrainian alphabetical sorting', () => {
    expect(cleanSettlementNameForSort('с. Гатне (Києво-Святошинський район)')).toBe('гатне києво-святошинський район');
    expect(cleanSettlementNameForSort('смт Баришівка')).toBe('баришівка');
    expect(cleanSettlementNameForSort('м. Біла Церква')).toBe('біла церква');

    expect(cleanStreetNameForSort('вул. Хрещатик')).toBe('хрещатик');
    expect(cleanStreetNameForSort('просп. Берестейський')).toBe('берестейський');
    expect(cleanStreetNameForSort('вул. Антоновича')).toBe('антоновича');
  });

  it('settlements list begins alphabetically and search finds a village', async () => {
    const initialList = await searchSettlements('krem', '');
    expect(initialList.length).toBeGreaterThan(10);
    const firstClean = cleanSettlementNameForSort(initialList[0]);
    expect(firstClean.startsWith('а') || firstClean.startsWith('б')).toBe(true);

    const matches = await searchSettlements('krem', 'Гатне');
    expect(matches.some((s) => s.includes('Гатне'))).toBe(true);
  });

  it('Kyiv streets list begins alphabetically', async () => {
    const initialStreets = await searchStreets('kem', 'м. Київ', '');
    expect(initialStreets.length).toBeGreaterThan(10);
    const firstClean = cleanStreetNameForSort(initialStreets[0].name);
    expect(firstClean.startsWith('а')).toBe(true);
  });

  it('village streets are sorted alphabetically and filterable', async () => {
    const streets = await searchStreets('krem', 'с. Гатне', '');
    expect(streets.length).toBeGreaterThan(10);
    const names = streets.map((s) => s.name);
    const sorted = [...names].sort((a, b) =>
      cleanStreetNameForSort(a).localeCompare(cleanStreetNameForSort(b), 'uk')
    );
    expect(names.slice(0, 5)).toEqual(sorted.slice(0, 5));
    const filtered = await searchStreets('krem', 'с. Гатне', 'Центр');
    expect(filtered.some((s) => s.name.includes('Центральна'))).toBe(true);
  });

  it('never invents a DTEK group for a house it has no verified data for', async () => {
    for (const [region, city, street] of [
      ['kem', 'м. Київ', 'вул. Хрещатик'],
      ['krem', 'с. Гатне', 'вул. Центральна'],
    ] as const) {
      const all = await lookupHouseGroup(region, city, street, undefined, '');
      expect(all.houses.length).toBeGreaterThan(10);
      expect(all.houses.every((h) => h.group === undefined)).toBe(true);

      const one = await lookupHouseGroup(region, city, street, undefined, '19');
      expect(one.houses[0].house).toBe('19');
      expect(one.detectedGroup).toBeUndefined();
    }
  });
});
