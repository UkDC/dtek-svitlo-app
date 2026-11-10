import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { carryEmergencyFlag, fetchAllSchedules } from '../src/services/clientScheduleApi';
import { GroupSchedule, parseDtekFactDay } from '../src/services/scheduleNormalizer';

const TODAY = '2026-11-10';
const TOMORROW = '2026-11-11';
// 2026-11-10 00:00 in Kyiv (UTC+2)
const TODAY_TS = Date.UTC(2026, 10, 9, 22, 0, 0) / 1000;

function group(status: 'ScheduleApplies' | 'EmergencyShutdowns'): GroupSchedule {
  const today = parseDtekFactDay({ '1': 'yes' }, TODAY_TS, TODAY);
  today.status = status;
  return {
    groupKey: 'GPV13.1',
    displayGroup: '13.1',
    region: 'kem',
    today,
    tomorrow: parseDtekFactDay(undefined, 0, TOMORROW),
    source: 'test',
    updatedAt: '12:00',
  };
}

describe('carryEmergencyFlag', () => {
  it('copies the emergency flag only from a fresh snapshot', () => {
    expect(carryEmergencyFlag(group('EmergencyShutdowns'), group('ScheduleApplies'), true).today.status).toBe(
      'EmergencyShutdowns'
    );
    expect(carryEmergencyFlag(group('EmergencyShutdowns'), group('ScheduleApplies'), false).today.status).toBe(
      'ScheduleApplies'
    );
  });

  it('does nothing when the snapshot has no emergency or no such group', () => {
    expect(carryEmergencyFlag(group('ScheduleApplies'), group('ScheduleApplies'), true).today.status).toBe(
      'ScheduleApplies'
    );
    expect(carryEmergencyFlag(undefined, group('ScheduleApplies'), true).today.status).toBe('ScheduleApplies');
  });
});

describe('fetchAllSchedules: a stale Pages snapshot must not keep «emergency» on screen', () => {
  const live = { fact: { data: { [String(TODAY_TS)]: { 'GPV13.1': { '1': 'yes' } } } } };
  const bundle = (status: 'ScheduleApplies' | 'EmergencyShutdowns') => ({
    kem: { '13.1': group(status) },
    krem: {},
    kemGroups: ['13.1'],
    kremGroups: [],
    fetchedAt: '2026-11-10T08:56:00Z',
    sourceLabel: 'snapshot',
  });
  const json = (body: unknown) => ({ ok: true, json: async () => body });
  const missing = { ok: false, json: async () => ({}) };

  function stubFetch(opts: { main: unknown | null; pages: unknown | null }) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.startsWith('./api/schedules')) return missing;
        if (url.includes('Baskerville42') && url.includes('/kyiv.json')) return json(live);
        if (url.includes('Baskerville42')) return missing;
        if (url.includes('raw.githubusercontent.com/UkDC')) return opts.main ? json(opts.main) : missing;
        if (url.startsWith('./state/')) return opts.pages ? json(opts.pages) : missing;
        return missing;
      })
    );
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-10T13:20:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fresh snapshot from main with emergency → emergency is shown', async () => {
    stubFetch({ main: bundle('EmergencyShutdowns'), pages: bundle('EmergencyShutdowns') });
    const r = await fetchAllSchedules(true);
    expect(r.kem['13.1'].today.status).toBe('EmergencyShutdowns');
  });

  it('main says the emergency is over, Pages copy is stale → no emergency', async () => {
    stubFetch({ main: bundle('ScheduleApplies'), pages: bundle('EmergencyShutdowns') });
    const r = await fetchAllSchedules(true);
    expect(r.kem['13.1'].today.status).toBe('ScheduleApplies');
  });

  it('main unreachable, only the stale Pages copy has the emergency → not carried onto live data', async () => {
    stubFetch({ main: null, pages: bundle('EmergencyShutdowns') });
    const r = await fetchAllSchedules(true);
    expect(r.kem['13.1'].today.status).toBe('ScheduleApplies');
  });
});
