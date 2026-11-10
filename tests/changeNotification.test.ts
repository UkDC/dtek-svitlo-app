import { describe, expect, it } from 'vitest';
import {
  DaySchedule,
  ScheduleChange,
  buildChangeNotification,
  formatHoursUk,
  makeWaitingDay,
  parseYasnoDay,
  truncateText,
} from '../src/services/scheduleNormalizer';

function day(dateKey: string, off: Array<[number, number]>): DaySchedule {
  const slots: Array<{ start: number; end: number; type: string }> = [];
  let cursor = 0;
  for (const [s, e] of off) {
    if (s > cursor) slots.push({ start: cursor, end: s, type: 'NotPlanned' });
    slots.push({ start: s, end: e, type: 'Definite' });
    cursor = e;
  }
  if (cursor < 1440) slots.push({ start: cursor, end: 1440, type: 'NotPlanned' });
  return parseYasnoDay({ date: `${dateKey}T00:00:00+02:00`, status: 'ScheduleApplies', slots }, dateKey);
}

const D = '2026-11-09';
const T = '2026-11-10';
const change = (dayLabel: 'Сьогодні' | 'Завтра', prev: DaySchedule, next: DaySchedule): ScheduleChange => ({ dayLabel, prev, next });

describe('buildChangeNotification', () => {
  it('today: new outages and what they were', () => {
    const r = buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), day(D, [[960, 1200]]))]);
    expect(r.title).toBe('🗓️ Графік змінено');
    expect(r.body).toBe('Дім · сьогодні: відключення 16:00–20:00 (було 14:00–18:00)');
  });

  it('tomorrow gets its own wording', () => {
    const r = buildChangeNotification('Дім', [change('Завтра', day(T, [[0, 240]]), day(T, [[360, 600]]))]);
    expect(r.title).toBe('🗓️ Графік змінено');
    expect(r.body).toBe('Дім · завтра: відключення 06:00–10:00 (було 00:00–04:00)');
  });

  it('outages removed → «Без відключень», outages appeared → was «без відключень»', () => {
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), day(D, []))]).body).toBe(
      'Дім · сьогодні: без відключень (було 14:00–18:00)'
    );
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, []), day(D, [[840, 1080]]))]).body).toBe(
      'Дім · сьогодні: відключення 14:00–18:00 (було без відключень)'
    );
  });

  it('several outages are listed', () => {
    const r = buildChangeNotification('Дім', [change('Сьогодні', day(D, []), day(D, [[0, 240], [840, 1080]]))]);
    expect(r.body).toContain('Дім · сьогодні: відключення 00:00–04:00, 14:00–18:00');
  });

  it('a tomorrow schedule published for the first time is «опубліковано», not «змінено»', () => {
    const r = buildChangeNotification('Дім', [change('Завтра', makeWaitingDay(T), day(T, [[840, 1080]]))]);
    expect(r.title).toBe('🗓️ Графік на завтра');
    expect(r.body).toBe('Дім · відключення 14:00–18:00');
  });

  it('emergency and waiting states', () => {
    const emergency = { ...day(D, []), status: 'EmergencyShutdowns' as const };
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), emergency)]).body).toBe(
      'Дім · сьогодні: екстрені відключення (було 14:00–18:00)'
    );
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), makeWaitingDay(D))]).body).toBe(
      'Дім · сьогодні: графік очікується (було 14:00–18:00)'
    );
  });

  it('emergency lifted → «замість екстрених відключень», not «було екстрені…»', () => {
    const emergency = { ...day(D, []), status: 'EmergencyShutdowns' as const };
    const r = buildChangeNotification('Дім', [change('Сьогодні', emergency, day(D, [[0, 210], [450, 930], [1020, 1440]]))]);
    expect(r.body).toBe(
      'Дім · сьогодні: відключення 00:00–03:30, 07:30–15:30, 17:00–24:00 (замість екстрених відключень)'
    );
    expect(r.body).not.toContain('було');
  });

  it('both days changed → one line per day, short title', () => {
    const r = buildChangeNotification('Дім', [
      change('Сьогодні', day(D, [[840, 1080]]), day(D, [[960, 1200]])),
      change('Завтра', day(T, []), day(T, [[360, 600]])),
    ]);
    expect(r.title).toBe('🗓️ Графік змінено');
    expect(r.body.split('\n')).toEqual([
      'Дім',
      'Сьогодні: відключення 16:00–20:00 (було 14:00–18:00)',
      'Завтра: відключення 06:00–10:00 (було без відключень)',
    ]);
  });

  it('keeps the body short and never exposes a street (only the name passed in)', () => {
    const many = day(D, [[0, 60], [120, 180], [240, 300], [360, 420], [480, 540], [600, 660], [720, 780], [840, 900]]);
    const r = buildChangeNotification('Дім', [change('Сьогодні', day(D, []), many)]);
    expect(r.body.length).toBeLessThanOrEqual(110);
    expect(r.body.endsWith('…')).toBe(true);
  });

  it('intraday change: omits outages for today that already ended', () => {
    // 03:30–10:00 (210..600), 13:00–20:30 (780..1230), 23:30–24:00 (1410..1440)
    const prev = day(D, [[210, 600], [780, 1230], [1410, 1440]]);
    // 03:30–10:00 (210..600), 13:00–21:30 (780..1290)
    const next = day(D, [[210, 600], [780, 1290]]);
    // 19:10 Kyiv time = 19 * 60 + 10 = 1150
    const r = buildChangeNotification('Дом', [change('Сьогодні', prev, next)], 1150);
    expect(r.title).toBe('🗓️ Графік змінено');
    expect(r.body).toBe('Дом · сьогодні: відключення 13:00–21:30 (було 13:00–20:30, 23:30–24:00)');
    expect(r.body).not.toContain('03:30');
  });

  it('intraday change: upcoming outage cancelled after morning outage finished', () => {
    // Morning 08:00–12:00 (480..720), Evening 18:00–22:00 (1080..1320)
    const prev = day(D, [[480, 720], [1080, 1320]]);
    // Only morning left
    const next = day(D, [[480, 720]]);
    // 14:00 Kyiv time = 840
    const r = buildChangeNotification('Дом', [change('Сьогодні', prev, next)], 840);
    expect(r.body).toBe('Дом · сьогодні: без відключень (було 18:00–22:00)');
  });

  it('intraday fallback: shows full day if change was strictly in the past', () => {
    const prev = day(D, [[480, 600]]); // 08:00–10:00
    const next = day(D, [[480, 660]]); // 08:00–11:00
    // At 15:00 (900 min), both intervals already ended
    const r = buildChangeNotification('Дом', [change('Сьогодні', prev, next)], 900);
    expect(r.body).toBe('Дом · сьогодні: відключення 08:00–11:00 (було 08:00–10:00)');
  });

  it('tomorrow outages are never filtered by nowMinutes', () => {
    const prev = day(T, [[0, 240]]);
    const next = day(T, [[360, 600]]);
    const r = buildChangeNotification('Дім', [change('Завтра', prev, next)], 1150);
    expect(r.body).toBe('Дім · завтра: відключення 06:00–10:00 (було 00:00–04:00)');
  });
});

describe('text helpers', () => {
  it('formatHoursUk uses a decimal comma', () => {
    expect(formatHoursUk(4)).toBe('4 год');
    expect(formatHoursUk(3.5)).toBe('3,5 год');
    expect(formatHoursUk(0.5)).toBe('0,5 год');
  });

  it('truncateText', () => {
    expect(truncateText('abc', 5)).toBe('abc');
    expect(truncateText('abcdefgh', 5)).toBe('abcd…');
  });
});
