import { describe, expect, it } from 'vitest';
import {
  OUTER_GAP_MINUTES,
  RING_CENTER,
  RING_RADIUS_INNER,
  RING_RADIUS_OUTER,
  RING_STROKE_ACTIVE,
  RING_STROKE_EVEN,
  RING_STROKE_IDLE,
  buildHourLabels,
  buildRingArcs,
  buildRingAriaLabel,
  circumferenceOf,
  planDial,
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
const TODAY = slotsFromRanges([
  [0, 210],
  [570, 750],
  [1170, 1320],
]);
// tomorrow: light 00:00–04:30, 09:00–12:00
const TOMORROW = slotsFromRanges([
  [0, 270],
  [540, 720],
]);

const sum = (arcs: { length: number }[]) => arcs.reduce((s, a) => s + a.length, 0);
const outerFull = () => circumferenceOf(RING_RADIUS_OUTER) * (1 - OUTER_GAP_MINUTES / 720);

describe('planDial: the rings never change meaning', () => {
  it('inner ring is always 00–12 and outer ring always 12–24, at any time and without «now»', () => {
    for (const now of [0, 615, 719, 720, 900, 1439, 1440, null]) {
      const plan = planDial({ slots: TODAY, nowMinutes: now });
      expect(plan.inner.radius).toBe(RING_RADIUS_INNER);
      expect(plan.outer.radius).toBe(RING_RADIUS_OUTER);
      expect(plan.inner.arcs.every((a) => a.startMinutes >= 0 && a.endMinutes <= 720)).toBe(true);
      expect(plan.outer.arcs.every((a) => a.startMinutes >= 720 && a.endMinutes <= 1440)).toBe(true);
      expect(plan.inner.hourLabels.map((l) => l.text)).toEqual(['00', '03', '06', '09']);
      expect(plan.outer.hourLabels.map((l) => l.text)).toEqual(['12', '15', '18', '21']);
    }
  });

  it('inner ring tiles its circle exactly; the outer one minus a small break at 12 o’clock', () => {
    for (const now of [100, 615, 720, 900, null]) {
      const plan = planDial({ slots: TODAY, nowMinutes: now });
      expect(sum(plan.inner.arcs)).toBeCloseTo(circumferenceOf(RING_RADIUS_INNER), 0);
      expect(sum(plan.outer.arcs)).toBeCloseTo(outerFull(), 0);
    }
    const plan = planDial({ slots: TODAY, nowMinutes: 615 });
    expect(plan.outer.arcs[0].startMinutes).toBe(720 + OUTER_GAP_MINUTES / 2);
    expect(plan.outer.arcs[plan.outer.arcs.length - 1].endMinutes).toBe(1440 - OUTER_GAP_MINUTES / 2);
    // dasharray offsets are relative to the start of each half (12 o'clock at the top)
    expect(plan.inner.arcs[0].offset).toBeCloseTo(0, 5);
  });
});

describe('planDial: which half is emphasised', () => {
  it('before noon the inner ring is thick and the outer one thin; 11:59 is still the morning', () => {
    for (const now of [0, 615, 719]) {
      const plan = planDial({ slots: TODAY, nowMinutes: now });
      expect(plan.activeHalf).toBe(0);
      expect(plan.inner).toMatchObject({ active: true, strokeWidth: RING_STROKE_ACTIVE });
      expect(plan.outer).toMatchObject({ active: false, strokeWidth: RING_STROKE_IDLE });
    }
  });

  it('flips exactly at 12:00 and stays through 23:59 and 24:00', () => {
    for (const now of [720, 1439, 1440]) {
      const plan = planDial({ slots: TODAY, nowMinutes: now });
      expect(plan.activeHalf).toBe(1);
      expect(plan.inner).toMatchObject({ active: false, strokeWidth: RING_STROKE_IDLE });
      expect(plan.outer).toMatchObject({ active: true, strokeWidth: RING_STROKE_ACTIVE });
    }
  });

  it('without «now» (tomorrow tab) both rings are even and nothing is dimmed', () => {
    const plan = planDial({ slots: TOMORROW, nowMinutes: null });
    expect(plan.activeHalf).toBeNull();
    expect(plan.nowFraction).toBeNull();
    expect(plan.inner).toMatchObject({ active: false, strokeWidth: RING_STROKE_EVEN });
    expect(plan.outer).toMatchObject({ active: false, strokeWidth: RING_STROKE_EVEN });
    expect([...plan.inner.arcs, ...plan.outer.arcs].every((a) => !a.past)).toBe(true);
  });
});

describe('planDial: past / remainder split', () => {
  it('in the morning: dims the past, cuts a run at «now», the evening ring is all future', () => {
    // 10:15 — inside the 09:30–12:30 light run
    const plan = planDial({ slots: TODAY, nowMinutes: 615 });
    expect(plan.inner.arcs.filter((a) => a.past).map((a) => [a.status, a.startMinutes, a.endMinutes])).toEqual([
      ['on', 0, 210],
      ['off', 210, 570],
      ['on', 570, 615],
    ]);
    expect(plan.inner.arcs.filter((a) => !a.past).map((a) => [a.status, a.startMinutes, a.endMinutes])).toEqual([
      ['on', 615, 720],
    ]);
    expect(plan.outer.arcs.some((a) => a.past)).toBe(false);
  });

  it('in the evening: the whole morning ring is past, the evening ring is split at «now»', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 14 * 60 + 20 }); // 14:20
    expect(plan.inner.arcs.every((a) => a.past)).toBe(true);
    const rest = plan.outer.arcs.filter((a) => !a.past);
    expect(rest[0].startMinutes).toBe(860);
    expect(rest[rest.length - 1].endMinutes).toBe(1440 - OUTER_GAP_MINUTES / 2);
  });

  it('at 12:00 sharp nothing of the evening is in the past yet', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 720 });
    expect(plan.outer.arcs.some((a) => a.past)).toBe(false);
    expect(plan.inner.arcs.every((a) => a.past)).toBe(true);
  });

  it('a run crossing 12:00 is split between the two rings', () => {
    const slots = slotsFromRanges([[600, 840]]); // 10:00–14:00
    const plan = planDial({ slots, nowMinutes: 780 });
    expect(plan.inner.arcs.filter((a) => a.status === 'on').map((a) => [a.startMinutes, a.endMinutes])).toEqual([
      [600, 720],
    ]);
    expect(plan.outer.arcs.filter((a) => a.status === 'on').map((a) => [a.startMinutes, a.endMinutes])).toEqual([
      [720 + OUTER_GAP_MINUTES / 2, 780],
      [780, 840],
    ]);
  });
});

describe('planDial: hour digits and «now» position', () => {
  it('uses real 24-hour digits for each half', () => {
    expect(buildHourLabels(0).map((l) => l.text)).toEqual(['00', '03', '06', '09']);
    expect(buildHourLabels(1).map((l) => l.text)).toEqual(['12', '15', '18', '21']);
    expect(buildHourLabels(1).map((l) => l.fraction)).toEqual([0, 0.25, 0.5, 0.75]);
  });

  it('now fraction follows the analog clock', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 180 }).nowFraction).toBeCloseTo(0.25, 5);
    expect(planDial({ slots: TODAY, nowMinutes: 15 * 60 }).nowFraction).toBeCloseTo(0.25, 5);
    expect(planDial({ slots: TODAY, nowMinutes: 720 }).nowFraction).toBeCloseTo(0, 5);
  });

  it('marker sits on the inner ring in the morning and on the outer ring in the evening', () => {
    const top = ringMarkerPosition(0);
    expect(top.half).toBe(0);
    expect(top.x).toBeCloseTo(RING_CENTER, 5);
    expect(top.y).toBeCloseTo(RING_CENTER - RING_RADIUS_INNER, 5);
    expect(ringMarkerPosition(6 * 60).y).toBeCloseTo(RING_CENTER + RING_RADIUS_INNER, 5);
    const three = ringMarkerPosition(15 * 60);
    expect(three.half).toBe(1);
    expect(three.x).toBeCloseTo(RING_CENTER + RING_RADIUS_OUTER, 5);
    expect(three.y).toBeCloseTo(RING_CENTER, 5);
  });

  it('24:00 stays at the end of the evening ring instead of wrapping to the morning', () => {
    const end = ringMarkerPosition(1440);
    expect(end.half).toBe(1);
    expect(end.x).toBeCloseTo(RING_CENTER, 0);
  });
});

describe('planDial: edge cases', () => {
  it('handles a full day of light, a full day of outage and an empty list', () => {
    const allOn = planDial({ slots: Array(48).fill('on'), nowMinutes: null });
    expect(allOn.inner.arcs).toHaveLength(1);
    expect(allOn.inner.arcs[0].length).toBeCloseTo(circumferenceOf(RING_RADIUS_INNER), 1);
    expect(allOn.outer.arcs).toHaveLength(1);
    expect(planDial({ slots: Array(48).fill('off'), nowMinutes: null }).inner.arcs).toHaveLength(1);
    const empty = planDial({ slots: [], nowMinutes: null });
    expect(empty.inner.arcs).toEqual([]);
    expect(empty.outer.arcs).toEqual([]);
  });

  it('keeps maybe slots as their own arcs', () => {
    const slots: HalfHourSlotStatus[] = Array(48).fill('on');
    slots[10] = 'maybe';
    slots[11] = 'maybe';
    const arcs = buildRingArcs(slots);
    expect(arcs.map((a) => a.status)).toEqual(['on', 'maybe', 'on']);
    expect(arcs[1].startMinutes).toBe(300);
    expect(arcs[1].endMinutes).toBe(360);
    expect(planDial({ slots, nowMinutes: null }).inner.arcs.some((a) => a.status === 'maybe')).toBe(true);
  });
});

describe('buildRingAriaLabel', () => {
  it('describes the whole day (not split by half)', () => {
    expect(buildRingAriaLabel(buildRingArcs(TODAY))).toBe(
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
