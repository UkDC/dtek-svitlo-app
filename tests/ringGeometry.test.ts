import { describe, expect, it } from 'vitest';
import {
  RING_CENTER,
  RING_RADIUS_MAIN,
  RING_RADIUS_TRACK,
  TRACK_GAP_MINUTES,
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

describe('planDial: which half the main ring shows', () => {
  it('before noon the main ring is 00–12 and 11:59 is still the first half', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 0 }).half).toBe(0);
    expect(planDial({ slots: TODAY, nowMinutes: 615 }).half).toBe(0);
    expect(planDial({ slots: TODAY, nowMinutes: 719 }).half).toBe(0);
  });

  it('flips to 12–24 exactly at 12:00 and stays there through 23:59 and 24:00', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 720 }).half).toBe(1);
    expect(planDial({ slots: TODAY, nowMinutes: 1439 }).half).toBe(1);
    expect(planDial({ slots: TODAY, nowMinutes: 1440 }).half).toBe(1);
  });

  it('without «now» (tomorrow tab) shows 00–12 and does not dim anything', () => {
    const plan = planDial({ slots: TOMORROW, nowMinutes: null });
    expect(plan.half).toBe(0);
    expect(plan.nowFraction).toBeNull();
    expect(plan.main.every((a) => !a.past)).toBe(true);
    expect(plan.main.every((a) => a.endMinutes <= 720)).toBe(true);
    // track = the same day's 12–24
    expect(plan.track).not.toBeNull();
    expect(plan.track!.every((a) => a.startMinutes >= 720)).toBe(true);
  });
});

describe('planDial: past / remainder split', () => {
  it('dims the past, keeps the remainder bright, and cuts a run at «now»', () => {
    // 10:15 — inside the 09:30–12:30 light run
    const plan = planDial({ slots: TODAY, nowMinutes: 615 });
    const past = plan.main.filter((a) => a.past);
    const rest = plan.main.filter((a) => !a.past);
    expect(past.map((a) => [a.status, a.startMinutes, a.endMinutes])).toEqual([
      ['on', 0, 210],
      ['off', 210, 570],
      ['on', 570, 615],
    ]);
    expect(rest.map((a) => [a.status, a.startMinutes, a.endMinutes])).toEqual([['on', 615, 720]]);
  });

  it('arcs of the main ring tile the ring exactly, for both halves', () => {
    for (const now of [100, 615, 719, 720, 900, 1439]) {
      const plan = planDial({ slots: TODAY, nowMinutes: now });
      expect(sum(plan.main)).toBeCloseTo(circumferenceOf(RING_RADIUS_MAIN), 0);
    }
  });

  it('after noon the morning arcs disappear and 12–24 is split at «now»', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 14 * 60 + 20 }); // 14:20
    expect(plan.main.every((a) => a.startMinutes >= 720)).toBe(true);
    const rest = plan.main.filter((a) => !a.past);
    expect(rest[0].startMinutes).toBe(860);
    expect(rest[rest.length - 1].endMinutes).toBe(1440);
    // dasharray offsets are relative to the start of the half (12:00 at the top)
    const first = plan.main[0];
    expect(first.offset).toBeCloseTo(0, 5);
  });

  it('at 12:00 sharp nothing of the new half is in the past yet', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 720 });
    expect(plan.main.some((a) => a.past)).toBe(false);
  });

  it('keeps the run that crosses 12:00 as a separate arc in each half', () => {
    const slots = slotsFromRanges([[600, 840]]); // 10:00–14:00
    const before = planDial({ slots, nowMinutes: 0 });
    expect(before.main.filter((a) => a.status === 'on').map((a) => [a.startMinutes, a.endMinutes])).toEqual([
      [600, 720],
    ]);
    const after = planDial({ slots, nowMinutes: 780 });
    expect(after.main.filter((a) => a.status === 'on').map((a) => [a.startMinutes, a.endMinutes])).toEqual([
      [720, 780],
      [780, 840],
    ]);
  });
});

describe('planDial: thin outer track = what comes next', () => {
  it('before noon the track is today’s 12–24', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 615, nextDaySlots: TOMORROW });
    expect(plan.trackStartMinutes).toBe(720);
    expect(plan.track).not.toBeNull();
    expect(plan.track!.every((a) => a.startMinutes >= 720 && !a.past)).toBe(true);
    // the track is one 12-hour circle minus a visible break at 12 o'clock
    const gap = (TRACK_GAP_MINUTES / 720) * circumferenceOf(RING_RADIUS_TRACK);
    expect(sum(plan.track!)).toBeCloseTo(circumferenceOf(RING_RADIUS_TRACK) - gap, 0);
    expect(plan.track![0].startMinutes).toBe(720 + TRACK_GAP_MINUTES / 2);
    expect(plan.track![plan.track!.length - 1].endMinutes).toBe(1440 - TRACK_GAP_MINUTES / 2);
  });

  it('after noon the track is TOMORROW’s 00–12, not today’s morning', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 14 * 60 + 20, nextDaySlots: TOMORROW });
    expect(plan.trackStartMinutes).toBe(0);
    const on = plan.track!.filter((a) => a.status === 'on').map((a) => [a.startMinutes, a.endMinutes]);
    expect(on).toEqual([
      [TRACK_GAP_MINUTES / 2, 270],
      [540, 720 - TRACK_GAP_MINUTES / 2],
    ]);
    const gap = (TRACK_GAP_MINUTES / 720) * circumferenceOf(RING_RADIUS_TRACK);
    expect(sum(plan.track!)).toBeCloseTo(circumferenceOf(RING_RADIUS_TRACK) - gap, 0);
  });

  it('after noon with no tomorrow schedule the track is null (placeholder), never today’s morning', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 900 }).track).toBeNull();
    expect(planDial({ slots: TODAY, nowMinutes: 900, nextDaySlots: [] }).track).toBeNull();
  });

  it('before noon a missing tomorrow does not matter', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 300 }).track).not.toBeNull();
  });
});

describe('planDial: digits and day tag on the thin track', () => {
  it('before noon the track is today 12–24 (not tagged as the next day)', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 615, nextDaySlots: TOMORROW });
    expect(plan.trackHourLabels.map((l) => l.text)).toEqual(['12', '15', '18', '21']);
    expect(plan.trackIsNextDay).toBe(false);
  });

  it('after noon the track digits are tomorrow 00/03/06/09 and tagged as the next day', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 900, nextDaySlots: TOMORROW });
    expect(plan.trackHourLabels.map((l) => l.text)).toEqual(['00', '03', '06', '09']);
    expect(plan.trackIsNextDay).toBe(true);
  });

  it('after noon without tomorrow: no digits, but still tagged as the next day', () => {
    const plan = planDial({ slots: TODAY, nowMinutes: 900 });
    expect(plan.track).toBeNull();
    expect(plan.trackHourLabels).toEqual([]);
    expect(plan.trackIsNextDay).toBe(true);
  });

  it('on the tomorrow tab (no «now») the track is the same day 12–24, not tagged', () => {
    const plan = planDial({ slots: TOMORROW, nowMinutes: null });
    expect(plan.trackHourLabels.map((l) => l.text)).toEqual(['12', '15', '18', '21']);
    expect(plan.trackIsNextDay).toBe(false);
  });
});

describe('planDial: hour digits and «now» position', () => {
  it('uses real 24-hour digits for each half', () => {
    expect(buildHourLabels(0).map((l) => l.text)).toEqual(['00', '03', '06', '09']);
    expect(buildHourLabels(1).map((l) => l.text)).toEqual(['12', '15', '18', '21']);
    expect(buildHourLabels(1).map((l) => l.fraction)).toEqual([0, 0.25, 0.5, 0.75]);
    expect(planDial({ slots: TODAY, nowMinutes: 100 }).hourLabels[0].text).toBe('00');
    expect(planDial({ slots: TODAY, nowMinutes: 800 }).hourLabels[0].text).toBe('12');
  });

  it('now fraction follows the analog clock', () => {
    expect(planDial({ slots: TODAY, nowMinutes: 180 }).nowFraction).toBeCloseTo(0.25, 5);
    expect(planDial({ slots: TODAY, nowMinutes: 15 * 60 }).nowFraction).toBeCloseTo(0.25, 5);
    expect(planDial({ slots: TODAY, nowMinutes: 720 }).nowFraction).toBeCloseTo(0, 5);
  });

  it('marker sits on the main ring at the analog position', () => {
    const top = ringMarkerPosition(0);
    expect(top.half).toBe(0);
    expect(top.x).toBeCloseTo(RING_CENTER, 5);
    expect(top.y).toBeCloseTo(RING_CENTER - RING_RADIUS_MAIN, 5);
    const three = ringMarkerPosition(15 * 60);
    expect(three.half).toBe(1);
    expect(three.x).toBeCloseTo(RING_CENTER + RING_RADIUS_MAIN, 5);
    expect(three.y).toBeCloseTo(RING_CENTER, 5);
    expect(ringMarkerPosition(6 * 60).y).toBeCloseTo(RING_CENTER + RING_RADIUS_MAIN, 5);
  });

  it('24:00 stays at the end of the second half instead of wrapping to the start', () => {
    const end = ringMarkerPosition(1440);
    expect(end.half).toBe(1);
    expect(end.x).toBeCloseTo(RING_CENTER, 0);
  });
});

describe('planDial: edge cases', () => {
  it('handles a full day of light, a full day of outage and an empty list', () => {
    const allOn = planDial({ slots: Array(48).fill('on'), nowMinutes: null });
    expect(allOn.main).toHaveLength(1);
    expect(allOn.main[0].length).toBeCloseTo(circumferenceOf(RING_RADIUS_MAIN), 1);
    expect(planDial({ slots: Array(48).fill('off'), nowMinutes: null }).main).toHaveLength(1);
    expect(planDial({ slots: [], nowMinutes: null }).main).toEqual([]);
  });

  it('keeps maybe slots as their own arcs', () => {
    const slots: HalfHourSlotStatus[] = Array(48).fill('on');
    slots[10] = 'maybe';
    slots[11] = 'maybe';
    const arcs = buildRingArcs(slots);
    expect(arcs.map((a) => a.status)).toEqual(['on', 'maybe', 'on']);
    expect(arcs[1].startMinutes).toBe(300);
    expect(arcs[1].endMinutes).toBe(360);
    expect(planDial({ slots, nowMinutes: null }).main.some((a) => a.status === 'maybe')).toBe(true);
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
