import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DaySchedule,
  GroupSchedule,
  SavedAddress,
  evaluateUpcomingAlerts,
  getCurrentAddressStatus,
  getShortAddress,
  kyivDateKeyFromTimestamp,
  makeWaitingDay,
  parseYasnoDay,
  rolloverGroupSchedule,
  toSyncAddress,
} from '../src/services/scheduleNormalizer';
import { parseOutageDataUaBundle } from '../src/services/clientScheduleApi';
import { ledgerKey, ledgerViewFor } from '../server/services/notificationScheduler';

/** Builds a day whose outages are the given [startMin, endMin) ranges. */
function dayWithOutages(dateKey: string, off: Array<[number, number]>): DaySchedule {
  const slots: Array<{ start: number; end: number; type: string }> = [];
  let cursor = 0;
  for (const [s, e] of off) {
    if (s > cursor) slots.push({ start: cursor, end: s, type: 'NotPlanned' });
    slots.push({ start: s, end: e, type: 'Definite' });
    cursor = e;
  }
  if (cursor < 1440) slots.push({ start: cursor, end: 1440, type: 'NotPlanned' });
  return parseYasnoDay(
    { date: `${dateKey}T00:00:00+02:00`, status: 'ScheduleApplies', slots },
    dateKey
  );
}

function group(today: DaySchedule, tomorrow: DaySchedule): GroupSchedule {
  return {
    groupKey: 'GPV1.1',
    displayGroup: '1.1',
    region: 'kem',
    today,
    tomorrow,
    source: 'test',
    updatedAt: 'test',
  };
}

const address: SavedAddress = {
  id: 'addr_default_kyiv',
  label: 'Дім',
  icon: '🏠',
  region: 'kem',
  city: 'м. Київ',
  street: 'вул. Хрещатик',
  house: '1',
  group: '1.1',
  notifyBeforeOff: true,
  notifyBeforeOn: true,
  notifyOnChange: true,
  createdAt: '2026-11-09T00:00:00Z',
};

afterEach(() => vi.useRealTimers());

describe('Outage-Data-UA parsing is keyed by real calendar date', () => {
  // Kyiv midnight of 2026-11-08 / 09 / 10 (UTC+2)
  const TS_08 = Date.parse('2026-11-07T22:00:00Z') / 1000;
  const TS_09 = Date.parse('2026-11-08T22:00:00Z') / 1000;
  const TS_10 = Date.parse('2026-11-09T22:00:00Z') / 1000;
  const hours = (offHours: number[]) => {
    const m: Record<string, string> = {};
    for (let h = 1; h <= 24; h++) m[String(h)] = offHours.includes(h) ? 'no' : 'yes';
    return m;
  };
  const raw = (days: Record<number, Record<string, string>>) => ({
    fact: {
      data: Object.fromEntries(
        Object.entries(days).map(([ts, hm]) => [ts, { 'GPV1.1': hm }])
      ),
    },
  });

  it('maps a timestamp to its Kyiv date', () => {
    expect(kyivDateKeyFromTimestamp(TS_09)).toBe('2026-11-09');
  });

  it('does not show yesterday as "today" when the mirror still carries yesterday + today', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z')); // 12:00 Kyiv, 9 Nov
    const res = parseOutageDataUaBundle(
      raw({ [TS_08]: hours([1, 2]), [TS_09]: hours([10, 11]) }),
      'kem',
      't'
    );
    const g = res['1.1'];
    expect(g.today.dateKey).toBe('2026-11-09');
    // today's outage is 09:00-11:00 (hours 10,11), NOT yesterday's 00:00-02:00
    expect(g.today.intervals.filter((i) => i.status === 'off').map((i) => i.start)).toEqual(['09:00']);
    expect(g.tomorrow.status).toBe('WaitingForSchedule');
  });

  it('returns nothing (instead of mislabelled data) when the mirror only has a past day', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T22:30:00Z')); // 00:30 Kyiv, 10 Nov
    const res = parseOutageDataUaBundle(raw({ [TS_09]: hours([10]) }), 'kem', 't');
    expect(Object.keys(res)).toHaveLength(0);
  });

  it('picks up tomorrow from its own timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T19:00:00Z')); // 21:00 Kyiv
    const res = parseOutageDataUaBundle(
      raw({ [TS_09]: hours([10]), [TS_10]: hours([5]) }),
      'kem',
      't'
    );
    expect(res['1.1'].tomorrow.status).toBe('ScheduleApplies');
    expect(res['1.1'].tomorrow.dateKey).toBe('2026-11-10');
  });
});

describe('rolloverGroupSchedule', () => {
  it('promotes cached tomorrow to today after midnight and never keeps a stale day', () => {
    const g = group(
      dayWithOutages('2026-11-09', [[600, 660]]),
      dayWithOutages('2026-11-10', [[120, 180]])
    );
    const next = rolloverGroupSchedule(g, '2026-11-10', '2026-11-11');
    expect(next.today.dateKey).toBe('2026-11-10');
    expect(next.today.intervals.find((i) => i.status === 'off')?.start).toBe('02:00');
    expect(next.tomorrow.status).toBe('WaitingForSchedule');

    const stale = rolloverGroupSchedule(g, '2026-11-15', '2026-11-16');
    expect(stale.today.status).toBe('WaitingForSchedule');
  });
});

describe('hero status', () => {
  it('shows "waiting" instead of "light is on" when today is unpublished', () => {
    const g = group(makeWaitingDay('2026-11-09'), makeWaitingDay('2026-11-10'));
    expect(getCurrentAddressStatus(g, 600).state).toBe('waiting');
  });

  it('reports the real restoration time for an outage that crosses midnight', () => {
    const g = group(
      dayWithOutages('2026-11-09', [[1320, 1440]]), // 22:00-24:00
      dayWithOutages('2026-11-10', [[0, 240], [600, 720]]) // 00:00-04:00, 10:00-12:00
    );
    const st = getCurrentAddressStatus(g, 1400); // 23:20
    expect(st.state).toBe('off');
    expect(st.targetTime).toBe('04:00');
    expect(st.targetIsTomorrow).toBe(true);
    expect(st.badgeText).toBe('немає світла до 04:00 (завтра)');
    expect(st.nextOutage?.start).toBe('10:00');
    expect(st.nextOutageIsTomorrow).toBe(true);
  });

  it('exposes the next outage while light is OFF (the push body relied on this)', () => {
    const g = group(
      dayWithOutages('2026-11-09', [[600, 720], [1200, 1380]]),
      makeWaitingDay('2026-11-10')
    );
    const st = getCurrentAddressStatus(g, 650); // inside 10:00-12:00
    expect(st.state).toBe('off');
    expect(st.targetTime).toBe('12:00');
    expect(st.nextOutage?.start).toBe('20:00');
    expect(st.nextOutageIsTomorrow).toBe(false);
  });
});

describe('push alerts across midnight', () => {
  const today = dayWithOutages('2026-11-09', [[1320, 1440]]); // 22:00-24:00
  const tomorrowContinues = dayWithOutages('2026-11-10', [[0, 30]]); // 00:00-00:30

  it('warns before an outage that starts exactly at 00:00 tomorrow', () => {
    const todayLightAtEnd = dayWithOutages('2026-11-09', []);
    const tomorrow = dayWithOutages('2026-11-10', [[0, 240]]);
    const t = evaluateUpcomingAlerts(address, todayLightAtEnd, 1410, {}, 10, 42, tomorrow); // 23:30
    expect(t).toHaveLength(1);
    expect(t[0].type).toBe('before_off');
    expect(t[0].title).toBe('🪫 Відключення о 00:00 • Дім');
    expect(t[0].body).toBe('до 04:00 · 4 год без світла');
    expect(t[0].eventId).toBe('addr_default_kyiv:2026-11-10:before_off:0');
    // without tomorrow's schedule nothing is known -> nothing is sent (old behaviour)
    expect(evaluateUpcomingAlerts(address, todayLightAtEnd, 1410, {})).toHaveLength(0);
  });

  it('treats 22:00-24:00 + 00:00-00:30 as one outage: no bogus restoration at 24:00', () => {
    const t = evaluateUpcomingAlerts(address, today, 1410 - 10, {}, 10, 42, tomorrowContinues);
    // at 23:20 (40 min before the 24:00 boundary, 70 before the real 00:30 restoration): nothing yet
    expect(t.filter((x) => x.type === 'before_on')).toHaveLength(0);
    // at 23:50 (40 min before 00:30): restoration warning fires, keyed to tomorrow
    const near = evaluateUpcomingAlerts(address, today, 1430, {}, 10, 42, tomorrowContinues);
    const on = near.filter((x) => x.type === 'before_on');
    expect(on).toHaveLength(1);
    expect(on[0].eventId).toBe('addr_default_kyiv:2026-11-10:before_on:30');
    expect(on[0].title).toBe('🔋 Світло буде о 00:30 • Дім');
  });

  it('the same event gets the same id from yesterday\'s and today\'s evaluation (no double push at midnight)', () => {
    const fromYesterday = evaluateUpcomingAlerts(address, today, 1430, {}, 10, 42, tomorrowContinues);
    const id = fromYesterday.find((x) => x.type === 'before_on')!.eventId;
    // after midnight "tomorrow" is today; restoration at 00:30 seen at 00:00 (30 min ahead)
    const fromToday = evaluateUpcomingAlerts(address, tomorrowContinues, 0, { [id]: 'sent' });
    expect(fromToday.filter((x) => x.type === 'before_on')).toHaveLength(0);
  });

  it('names the clock time of the event, not a lead time', () => {
    const day = dayWithOutages('2026-11-09', [[960, 1200]]); // 16:00-20:00
    const t = evaluateUpcomingAlerts(address, day, 920, {}); // 15:20 -> 40 min ahead
    expect(t[0].title).toBe('🪫 Відключення о 16:00 • Дім');
    expect(t[0].title).not.toMatch(/за \d+ хв/);
  });

  it('says «до завтра» when the outage ends on the next day and uses a decimal comma', () => {
    const t = evaluateUpcomingAlerts(address, today, 1290, {}, 10, 42, tomorrowContinues); // 21:30 -> outage at 22:00
    expect(t).toHaveLength(1);
    expect(t[0].title).toBe('🪫 Відключення о 22:00 • Дім');
    expect(t[0].body).toBe('до завтра 00:30 · 2,5 год без світла');
  });

  it('restoration push: how long the light lasts, merged across midnight', () => {
    // outage 10:00-12:00, light 12:00-24:00 and 00:00-02:00 tomorrow
    const d = dayWithOutages('2026-11-09', [[600, 720]]);
    const tm = dayWithOutages('2026-11-10', [[120, 1440]]);
    const t = evaluateUpcomingAlerts(address, d, 690, {}, 10, 42, tm); // 11:30
    const on = t.find((x) => x.type === 'before_on')!;
    expect(on.title).toBe('🔋 Світло буде о 12:00 • Дім');
    expect(on.body).toBe('до завтра 02:00 · 14 год зі світлом');
  });

  it('restoration push when only «maybe» follows does not invent a light period', () => {
    const day = parseYasnoDay(
      {
        date: '2026-11-09T00:00:00+02:00',
        status: 'ScheduleApplies',
        slots: [
          { start: 0, end: 600, type: 'NotPlanned' },
          { start: 600, end: 720, type: 'Definite' }, // 10:00-12:00
          { start: 720, end: 840, type: 'Possible' }, // 12:00-14:00 maybe
          { start: 840, end: 1440, type: 'NotPlanned' },
        ],
      },
      '2026-11-09'
    );
    const on = evaluateUpcomingAlerts(address, day, 690, {}).find((x) => x.type === 'before_on')!; // 11:30
    expect(on.body).toBe('Далі можливі відключення');
  });
});

describe('dedupe ledger is per subscriber', () => {
  it('a notification delivered to one device does not suppress the same event for another', () => {
    const day = dayWithOutages('2026-11-09', [[960, 1200]]);
    const ledger: Record<string, string> = {};

    const a = evaluateUpcomingAlerts(address, day, 930, ledgerViewFor(ledger, 'ios_A'));
    expect(a).toHaveLength(1);
    ledger[ledgerKey('ios_A', a[0].eventId)] = new Date().toISOString();

    // device B has the very same default address id
    const b = evaluateUpcomingAlerts(address, day, 930, ledgerViewFor(ledger, 'ios_B'));
    expect(b).toHaveLength(1);

    // device A is still de-duplicated
    expect(evaluateUpcomingAlerts(address, day, 935, ledgerViewFor(ledger, 'ios_A'))).toHaveLength(0);
  });

  it('honours legacy un-namespaced ledger entries after the upgrade', () => {
    const day = dayWithOutages('2026-11-09', [[960, 1200]]);
    const id = evaluateUpcomingAlerts(address, day, 930, {})[0].eventId;
    const legacy = { [id]: 'sent-before-upgrade' };
    expect(evaluateUpcomingAlerts(address, day, 930, ledgerViewFor(legacy, 'ios_A'))).toHaveLength(0);
  });
});

describe('push titles and synced records do not expose the address', () => {
  const home: SavedAddress = {
    ...address,
    label: 'вул. Хрещатик, 1',
    street: 'вул. Хрещатик',
    house: '1',
  };

  it('falls back to the settlement when the name is an address line', () => {
    expect(getShortAddress(home)).toBe('Київ');
    expect(
      getShortAddress({ ...home, region: 'krem', city: 'с. Гатне (Києво-Святошинський район)' })
    ).toBe('с. Гатне');
  });

  it('uses a short user alias as-is', () => {
    expect(getShortAddress({ ...home, label: 'Дача' })).toBe('Дача');
  });

  it('toSyncAddress strips street, house, city and label but keeps what the worker needs', () => {
    const s = toSyncAddress(home);
    const json = JSON.stringify(s);
    expect(json).not.toContain('Хрещатик');
    expect(s.street).toBe('');
    expect(s.house).toBe('');
    expect(s.city).toBe('');
    expect(s.label).toBe('');
    expect(s).toMatchObject({ id: home.id, region: 'kem', group: '1.1', notifyBeforeOff: true });
    // and the worker still produces a proper title from the stripped record
    const day = dayWithOutages('2026-11-09', [[960, 1200]]);
    const t = evaluateUpcomingAlerts(s, day, 930, {});
    expect(t[0].title).toBe('🪫 Відключення о 16:00 • Київ');
  });
});
