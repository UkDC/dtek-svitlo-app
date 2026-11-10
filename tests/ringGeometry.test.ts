import { describe, expect, it } from 'vitest';
import {
  RING_CENTER,
  RING_RADIUS_INNER,
  RING_RADIUS_OUTER,
  buildLapArcs,
  buildRingArcs,
  buildRingAriaLabel,
  ringCircumference,
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

// light 00:00–03:30, 09:30–12:30, 19:30–22:00
const MOCK = slotsFromRanges([
  [0, 210],
  [570, 750],
  [1170, 1320],
]);

describe('ringGeometry (two-lap dial)', () => {
  it('inner ring is 00–12, outer ring is 12–24', () => {
    expect(RING_RADIUS_INNER).toBeLessThan(RING_RADIUS_OUTER);
    const arcs = buildLapArcs(MOCK);
    expect(arcs.filter((a) => a.lap === 0).every((a) => a.endMinutes <= 720)).toBe(true);
    expect(arcs.filter((a) => a.lap === 1).every((a) => a.startMinutes >= 720)).toBe(true);
  });

  it('arcs of each ring tile that ring exactly', () => {
    const arcs = buildLapArcs(MOCK);
    for (const lap of [0, 1] as const) {
      const total = arcs.filter((a) => a.lap === lap).reduce((s, a) => s + a.length, 0);
      expect(total).toBeCloseTo(ringCircumference(lap), 0);
    }
  });

  it('splits a run that crosses 12:00 into two arcs, one per ring', () => {
    const slots = slotsFromRanges([[600, 840]]); // 10:00–14:00
    const on = buildLapArcs(slots).filter((a) => a.status === 'on');
    expect(on).toHaveLength(2);
    expect(on[0]).toMatchObject({ lap: 0, startMinutes: 600, endMinutes: 720 });
    expect(on[1]).toMatchObject({ lap: 1, startMinutes: 720, endMinutes: 840 });
    // 120 min of a 720-min lap on the inner ring; 120 min on the outer ring
    expect(on[0].length).toBeCloseTo((120 / 720) * ringCircumference(0), 1);
    expect(on[0].offset).toBeCloseTo(-(600 / 720) * ringCircumference(0), 1);
    expect(on[1].length).toBeCloseTo((120 / 720) * ringCircumference(1), 1);
    expect(on[1].offset).toBeCloseTo(0, 5);
  });

  it('marker: 00:00 top of inner ring, 12:00 top of outer ring', () => {
    const start = ringMarkerPosition(0);
    expect(start.lap).toBe(0);
    expect(start.x).toBeCloseTo(RING_CENTER, 5);
    expect(start.y).toBeCloseTo(RING_CENTER - RING_RADIUS_INNER, 5);
    const noon = ringMarkerPosition(720);
    expect(noon.lap).toBe(1);
    expect(noon.x).toBeCloseTo(RING_CENTER, 5);
    expect(noon.y).toBeCloseTo(RING_CENTER - RING_RADIUS_OUTER, 5);
  });

  it('marker follows the analog clock angle', () => {
    const three = ringMarkerPosition(3 * 60); // 03:00 → 3 o'clock, inner
    expect(three.lap).toBe(0);
    expect(three.x).toBeCloseTo(RING_CENTER + RING_RADIUS_INNER, 5);
    expect(three.y).toBeCloseTo(RING_CENTER, 5);
    const fifteen = ringMarkerPosition(15 * 60); // 15:00 → 3 o'clock, outer
    expect(fifteen.lap).toBe(1);
    expect(fifteen.x).toBeCloseTo(RING_CENTER + RING_RADIUS_OUTER, 5);
    expect(fifteen.y).toBeCloseTo(RING_CENTER, 5);
    expect(ringMarkerPosition(6 * 60).y).toBeCloseTo(RING_CENTER + RING_RADIUS_INNER, 5);
    expect(ringMarkerPosition(18 * 60).y).toBeCloseTo(RING_CENTER + RING_RADIUS_OUTER, 5);
  });

  it('boundaries: 11:59 is still the inner ring, 23:59 and 24:00 stay on the outer ring', () => {
    expect(ringMarkerPosition(719).lap).toBe(0);
    expect(ringMarkerPosition(1439).lap).toBe(1);
    const end = ringMarkerPosition(1440);
    expect(end.lap).toBe(1);
    expect(end.x).toBeCloseTo(RING_CENTER, 0); // just before the top, not wrapped to the inner ring
  });

  it('handles a full day of light, a full day of outage and an empty list', () => {
    const allOn = buildLapArcs(Array(48).fill('on'));
    expect(allOn).toHaveLength(2);
    expect(allOn.map((a) => a.lap)).toEqual([0, 1]);
    allOn.forEach((a) => expect(a.length).toBeCloseTo(a.circumference, 1));
    expect(buildLapArcs(Array(48).fill('off'))).toHaveLength(2);
    expect(buildLapArcs([])).toEqual([]);
  });

  it('keeps maybe slots as their own arcs', () => {
    const slots: HalfHourSlotStatus[] = Array(48).fill('on');
    slots[10] = 'maybe';
    slots[11] = 'maybe';
    const arcs = buildRingArcs(slots);
    expect(arcs.map((a) => a.status)).toEqual(['on', 'maybe', 'on']);
    expect(arcs[1].startMinutes).toBe(300);
    expect(arcs[1].endMinutes).toBe(360);
    expect(buildLapArcs(slots).some((a) => a.status === 'maybe' && a.lap === 0)).toBe(true);
  });

  it('builds the aria label for the whole day (not split by lap)', () => {
    expect(buildRingAriaLabel(buildRingArcs(MOCK))).toBe(
      'Доба: зі світлом 00:00–03:30, 09:30–12:30, 19:30–22:00; без світла решту часу'
    );
    expect(buildRingAriaLabel(buildRingArcs(slotsFromRanges([[600, 840]])))).toBe(
      'Доба: зі світлом 10:00–14:00; без світла решту часу'
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
