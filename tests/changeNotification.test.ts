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
    expect(r.title).toBe('🗓️ Графік на сьогодні змінено • Дім');
    expect(r.body).toBe('Відключення 16:00–20:00 (було 14:00–18:00)');
  });

  it('tomorrow gets its own wording', () => {
    const r = buildChangeNotification('Дім', [change('Завтра', day(T, [[0, 240]]), day(T, [[360, 600]]))]);
    expect(r.title).toBe('🗓️ Графік на завтра змінено • Дім');
    expect(r.body).toBe('Відключення 06:00–10:00 (було 00:00–04:00)');
  });

  it('outages removed → «Без відключень», outages appeared → was «без відключень»', () => {
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), day(D, []))]).body).toBe(
      'Без відключень (було 14:00–18:00)'
    );
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, []), day(D, [[840, 1080]]))]).body).toBe(
      'Відключення 14:00–18:00 (було без відключень)'
    );
  });

  it('several outages are listed', () => {
    const r = buildChangeNotification('Дім', [change('Сьогодні', day(D, []), day(D, [[0, 240], [840, 1080]]))]);
    expect(r.body).toContain('Відключення 00:00–04:00, 14:00–18:00');
  });

  it('a tomorrow schedule published for the first time is «опубліковано», not «змінено»', () => {
    const r = buildChangeNotification('Дім', [change('Завтра', makeWaitingDay(T), day(T, [[840, 1080]]))]);
    expect(r.title).toBe('🗓️ Опубліковано графік на завтра • Дім');
    expect(r.body).toBe('Відключення 14:00–18:00');
  });

  it('emergency and waiting states', () => {
    const emergency = { ...day(D, []), status: 'EmergencyShutdowns' as const };
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), emergency)]).body).toBe(
      'Екстрені відключення (було 14:00–18:00)'
    );
    expect(buildChangeNotification('Дім', [change('Сьогодні', day(D, [[840, 1080]]), makeWaitingDay(D))]).body).toBe(
      'Графік очікується (було 14:00–18:00)'
    );
  });

  it('both days changed → one line per day, short title', () => {
    const r = buildChangeNotification('Дім', [
      change('Сьогодні', day(D, [[840, 1080]]), day(D, [[960, 1200]])),
      change('Завтра', day(T, []), day(T, [[360, 600]])),
    ]);
    expect(r.title).toBe('🗓️ Графік змінено • Дім');
    expect(r.body.split('\n')).toEqual([
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
