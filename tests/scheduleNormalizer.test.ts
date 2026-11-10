import { describe, expect, it } from 'vitest';
import {
  SavedAddress,
  computeScheduleDiff,
  evaluateUpcomingAlerts,
  isWithinQuietHours,
  parseDtekFactDay,
  parseYasnoDay,
  sortGroupCodes,
} from '../src/services/scheduleNormalizer';

describe('scheduleNormalizer core engine', () => {
  it('sorts Kyiv and Oblast group codes numerically (1.1 .. 60.2)', () => {
    const raw = ['GPV20.1', 'GPV3.2', 'GPV1.1', 'GPV10.1', 'GPV3.1'];
    expect(sortGroupCodes(raw)).toEqual(['1.1', '3.1', '3.2', '10.1', '20.1']);
  });

  it('parses DTEK / Outage-Data-UA hour map including half-hour slots ("first" and "second")', () => {
    const hourMap: Record<string, string> = {};
    for (let h = 1; h <= 24; h++) hourMap[String(h)] = 'yes';
    // Hour "9" = 08:00..09:00 -> first 30m off (08:00..08:30)
    // Hour "10" = 09:00..10:00 -> full off (09:00..10:00)
    // Hour "11" = 10:00..11:00 -> second 30m off (10:30..11:00)
    hourMap['9'] = 'first';
    hourMap['10'] = 'no';
    hourMap['11'] = 'second';

    const day = parseDtekFactDay(hourMap, 1731103200, '2026-11-09', '09.11.2026 14:00');
    expect(day.totalOffHours).toBe(2);
    expect(day.totalOnHours).toBe(22);

    const offIntervals = day.intervals.filter((i) => i.status === 'off');
    expect(offIntervals.map((i) => `${i.start}-${i.end}`)).toEqual([
      '08:00-08:30',
      '09:00-10:00',
      '10:30-11:00',
    ]);
  });

  it('parses YASNO API v2 minute intervals (0..1440) accurately', () => {
    const yasnoDay = parseYasnoDay(
      {
        date: '2026-11-09T00:00:00+02:00',
        status: 'ScheduleApplies',
        slots: [
          { start: 0, end: 390, type: 'Definite' }, // 00:00 - 06:30 off
          { start: 390, end: 960, type: 'NotPlanned' }, // 06:30 - 16:00 on
          { start: 960, end: 1200, type: 'Definite' }, // 16:00 - 20:00 off
          { start: 1200, end: 1440, type: 'NotPlanned' }, // 20:00 - 24:00 on
        ],
      },
      '2026-11-09'
    );

    expect(yasnoDay.totalOffHours).toBe(10.5);
    const offIntervals = yasnoDay.intervals.filter((i) => i.status === 'off');
    expect(offIntervals.map((i) => `${i.start}-${i.end}`)).toEqual([
      '00:00-06:30',
      '16:00-20:00',
    ]);
  });

  it('detects intraday schedule changes and formats readable diff', () => {
    const prev = parseYasnoDay(
      {
        date: '2026-11-09T00:00:00+02:00',
        status: 'ScheduleApplies',
        slots: [
          { start: 0, end: 840, type: 'NotPlanned' },
          { start: 840, end: 1080, type: 'Definite' }, // 14:00 - 18:00
          { start: 1080, end: 1440, type: 'NotPlanned' },
        ],
      },
      '2026-11-09'
    );

    const next = parseYasnoDay(
      {
        date: '2026-11-09T00:00:00+02:00',
        status: 'ScheduleApplies',
        slots: [
          { start: 0, end: 960, type: 'NotPlanned' },
          { start: 960, end: 1200, type: 'Definite' }, // 16:00 - 20:00
          { start: 1200, end: 1440, type: 'NotPlanned' },
        ],
      },
      '2026-11-09'
    );

    const diff = computeScheduleDiff(prev, next, 'Сьогодні');
    expect(diff.hasChanged).toBe(true);
    expect(diff.summaryText).toContain('14:00–18:00');
    expect(diff.summaryText).toContain('16:00–20:00');
  });

  it('triggers ~30-minute warnings within [10..42]m sliding window and deduplicates via notifiedEvents', () => {
    const day = parseYasnoDay(
      {
        date: '2026-11-09T00:00:00+02:00',
        status: 'ScheduleApplies',
        slots: [
          { start: 0, end: 960, type: 'NotPlanned' },
          { start: 960, end: 1200, type: 'Definite' }, // 16:00 (960) - 20:00 (1200)
          { start: 1200, end: 1440, type: 'NotPlanned' },
        ],
      },
      '2026-11-09'
    );

    const address: SavedAddress = {
      id: 'addr_test',
      label: 'Моя квартира',
      icon: '🏠',
      region: 'kem',
      city: 'м. Київ',
      street: 'вул. Хрещатик',
      house: '22',
      group: '20.1',
      notifyBeforeOff: true,
      notifyBeforeOn: true,
      notifyOnChange: true,
      createdAt: '2026-11-09T00:00:00Z',
    };

    const notifiedEvents: Record<string, string> = {};

    // 15:30 (930m) -> 30 minutes before 16:00 (960m) outage start
    const triggersAt1530 = evaluateUpcomingAlerts(
      address,
      day,
      930,
      notifiedEvents
    );
    expect(triggersAt1530).toHaveLength(1);
    expect(triggersAt1530[0].type).toBe('before_off');
    expect(triggersAt1530[0].minutesRemaining).toBe(30);
    expect(triggersAt1530[0].title).toBe('🪫 Відключення о 16:00 • Моя квартира');
    expect(triggersAt1530[0].body).toBe('до 20:00 · 4 год без світла');

    // Record sent event -> next check at 15:38 (938m, 22m before outage) must NOT duplicate
    notifiedEvents[triggersAt1530[0].eventId] = new Date().toISOString();
    const triggersAt1538 = evaluateUpcomingAlerts(
      address,
      day,
      938,
      notifiedEvents
    );
    expect(triggersAt1538).toHaveLength(0);

    // 19:30 (1170m) -> 30 minutes before 20:00 (1200m) restoration
    const triggersAt1930 = evaluateUpcomingAlerts(
      address,
      day,
      1170,
      notifiedEvents
    );
    expect(triggersAt1930).toHaveLength(1);
    expect(triggersAt1930[0].type).toBe('before_on');
    expect(triggersAt1930[0].minutesRemaining).toBe(30);
    expect(triggersAt1930[0].title).toBe('🔋 Світло буде о 20:00 • Моя квартира');
    expect(triggersAt1930[0].body).toBe('до 24:00 · 4 год зі світлом');
  });

  it('evaluates overnight Quiet Hours (23:00 to 07:00) accurately', () => {
    expect(isWithinQuietHours(23 * 60 + 15, true, '23:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(3 * 60 + 30, true, '23:00', '07:00')).toBe(true);
    expect(isWithinQuietHours(14 * 60, true, '23:00', '07:00')).toBe(false);
    expect(isWithinQuietHours(23 * 60 + 15, false, '23:00', '07:00')).toBe(false);
  });
});
