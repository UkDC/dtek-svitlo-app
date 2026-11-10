import { describe, expect, it } from 'vitest';
import {
  RING_CIRCUMFERENCE,
  buildRingArcs,
  buildRingAriaLabel,
  ringMarkerPosition,
} from '../src/services/ringGeometry';
import type { HalfHourSlotStatus } from '../src/services/scheduleNormalizer';

function slotsFromRanges(on: Array<[number, number]>): HalfHourSlotStatus[] {
  const slots: HalfHourSlotStatus[] = Array(48).fill('off');
  for (const [from, to] of on) {
    for (let m = from; m < to; m += 30) slots[m / 30] = 'on';
  }
  return slots;
}

// B-Ring mockup: light 00:00–03:30, 09:30–12:30, 19:30–22:00
const MOCK = slotsFromRanges([
  [0, 210],
  [570, 750],
  [1170, 1320],
]);

describe('ringGeometry', () => {
  it('circumference is ~628.3', () => {
    expect(RING_CIRCUMFERENCE).toBeCloseTo(628.3, 1);
  });

  it('matches the mockup arcs', () => {
    const arcs = buildRingArcs(MOCK);
    expect(arcs.map((a) => a.status)).toEqual(['on', 'off', 'on', 'off', 'on', 'off']);
    const expected = [
      [91.6, 0],
      [157.1, -91.6],
      [78.5, -248.7],
      [183.3, -327.3],
      [65.5, -510.5],
      [52.4, -576],
    ];
    arcs.forEach((a, i) => {
      expect(a.length).toBeCloseTo(expected[i][0], 0);
      expect(a.offset).toBeCloseTo(expected[i][1], 0);
    });
    // arcs tile the circle with no gaps
    const total = arcs.reduce((s, a) => s + a.length, 0);
    expect(total).toBeCloseTo(RING_CIRCUMFERENCE, 0);
  });

  it('marker positions match the mockup control points', () => {
    const a = ringMarkerPosition(22 * 60 + 40);
    expect(a.x).toBeCloseTo(95.8, 1);
    expect(a.y).toBeCloseTo(36, 0);
    const b = ringMarkerPosition(10 * 60 + 15);
    expect(b.x).toBeCloseTo(174.2, 1);
    expect(b.y).toBeCloseTo(219.7, 1);
    const top = ringMarkerPosition(0);
    expect(top.x).toBeCloseTo(130, 5);
    expect(top.y).toBeCloseTo(30, 5);
    const bottom = ringMarkerPosition(12 * 60);
    expect(bottom.y).toBeCloseTo(230, 5);
  });

  it('handles a full day of light, a full day of outage and an empty list', () => {
    const allOn = buildRingArcs(Array(48).fill('on'));
    expect(allOn).toHaveLength(1);
    expect(allOn[0].length).toBeCloseTo(RING_CIRCUMFERENCE, 1);
    expect(allOn[0].offset).toBe(-0);
    const allOff = buildRingArcs(Array(48).fill('off'));
    expect(allOff).toHaveLength(1);
    expect(buildRingArcs([])).toEqual([]);
  });

  it('keeps maybe slots as their own arcs', () => {
    const slots: HalfHourSlotStatus[] = Array(48).fill('on');
    slots[10] = 'maybe';
    slots[11] = 'maybe';
    const arcs = buildRingArcs(slots);
    expect(arcs.map((a) => a.status)).toEqual(['on', 'maybe', 'on']);
    expect(arcs[1].startMinutes).toBe(300);
    expect(arcs[1].endMinutes).toBe(360);
  });

  it('builds the aria label', () => {
    expect(buildRingAriaLabel(buildRingArcs(MOCK))).toBe(
      'Доба: зі світлом 00:00–03:30, 09:30–12:30, 19:30–22:00; без світла решту часу'
    );
    expect(buildRingAriaLabel(buildRingArcs(Array(48).fill('on')))).toBe('Доба: світло є весь день');
    expect(buildRingAriaLabel(buildRingArcs(Array(48).fill('off')))).toBe('Доба: без світла весь день');
    expect(buildRingAriaLabel([])).toBe('Доба: графік відсутній');
  });

  it('labels a light period that runs to midnight as 24:00', () => {
    const slots = slotsFromRanges([[1320, 1440]]);
    expect(buildRingAriaLabel(buildRingArcs(slots))).toContain('22:00–24:00');
  });
});
