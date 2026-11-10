export type RegionId = 'kem' | 'krem';

export type HalfHourSlotStatus = 'on' | 'off' | 'maybe';

export type DayScheduleStatus =
  | 'ScheduleApplies'
  | 'WaitingForSchedule'
  | 'EmergencyShutdowns';

export interface TimeInterval {
  startMinutes: number; // 0..1440
  endMinutes: number; // 0..1440
  start: string; // "08:00"
  end: string; // "12:00"
  durationHours: number;
  status: HalfHourSlotStatus;
}

export interface DaySchedule {
  dateKey: string; // "YYYY-MM-DD" in Europe/Kyiv
  timestamp: number;
  status: DayScheduleStatus;
  slots: HalfHourSlotStatus[]; // 48 half-hour slots (index 0 = 00:00..00:30, index 47 = 23:30..24:00)
  intervals: TimeInterval[];
  totalOnHours: number;
  totalOffHours: number;
  updatedAt?: string;
}

export interface GroupSchedule {
  groupKey: string; // e.g., "GPV3.1" or "3.1"
  displayGroup: string; // e.g., "3.1" or "20.1"
  region: RegionId;
  today: DaySchedule;
  tomorrow: DaySchedule;
  source: string;
  updatedAt: string;
  emergencyNote?: string;
}

export interface SavedAddress {
  id: string;
  label: string; // Custom user-entered name, e.g., "Дім", "Батьки", "Робота"
  icon: string; // Emoji or icon identifier
  region: RegionId;
  city: string;
  street: string;
  house: string;
  group: string; // Normalized group e.g. "3.1" or "20.1"
  notifyBeforeOff: boolean;
  notifyBeforeOn: boolean;
  notifyOnChange: boolean;
  createdAt: string;
  /** Pre-computed name used in push titles; set when the address is synced without street/house */
  shortTitle?: string;
}

export interface ScheduleDiffResult {
  hasChanged: boolean;
  dayLabel: 'Сьогодні' | 'Завтра';
  dateKey: string;
  previousSummary: string;
  currentSummary: string;
  summaryText: string;
}

export interface UpcomingAlertTrigger {
  eventId: string;
  addressId: string;
  addressLabel: string;
  addressIcon: string;
  group: string;
  type: 'before_off' | 'before_on';
  targetMinutes: number;
  targetTimeStr: string;
  intervalStr: string;
  minutesRemaining: number;
  title: string;
  body: string;
  icon?: string;
}

/**
 * Formats minutes from midnight (0..1440) into "HH:MM"
 */
export function formatMinutesToTime(minutes: number): string {
  const clamped = Math.max(0, Math.min(1440, Math.round(minutes)));
  const h = Math.floor(clamped / 60);
  const m = clamped % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Normalizes group codes like "GPV3.1", "Група 3.1", "3.1" -> "3.1"
 */
export function normalizeGroupCode(raw: string): string {
  return raw
    .trim()
    .replace(/^GPV/i, '')
    .replace(/^ГПВ/i, '')
    .replace(/^Група\s*/i, '')
    .replace(/^Группа\s*/i, '')
    .trim();
}

/**
 * Sorts group codes numerically: "1.1", "1.2", "2.1", ..., "10.1", "20.1", "60.2"
 */
export function sortGroupCodes(groups: string[]): string[] {
  return [...new Set(groups.map(normalizeGroupCode))].sort((a, b) => {
    const [aMaj, aMin] = a.split('.').map((n) => parseInt(n, 10) || 0);
    const [bMaj, bMin] = b.split('.').map((n) => parseInt(n, 10) || 0);
    if (aMaj !== bMaj) return aMaj - bMaj;
    return aMin - bMin;
  });
}

/**
 * Merges 48 half-hour slots into contiguous TimeIntervals
 */
export function buildIntervalsFromSlots(slots: HalfHourSlotStatus[]): TimeInterval[] {
  if (!slots || slots.length === 0) return [];
  const intervals: TimeInterval[] = [];
  let currentStatus: HalfHourSlotStatus = slots[0];
  let startIdx = 0;

  for (let i = 1; i <= slots.length; i++) {
    const status = i < slots.length ? slots[i] : null;
    if (status !== currentStatus) {
      const startMinutes = startIdx * 30;
      const endMinutes = i * 30;
      intervals.push({
        startMinutes,
        endMinutes,
        start: formatMinutesToTime(startMinutes),
        end: formatMinutesToTime(endMinutes),
        durationHours: (endMinutes - startMinutes) / 60,
        status: currentStatus,
      });
      if (status !== null) {
        currentStatus = status;
        startIdx = i;
      }
    }
  }
  return intervals;
}

/**
 * Converts a DaySchedule's OFF intervals into a concise string like "08:00–12:00, 16:30–20:00"
 */
export function summarizeOffIntervals(day: DaySchedule): string {
  if (day.status === 'EmergencyShutdowns') {
    return 'Екстрені відключення поза графіком';
  }
  if (day.status === 'WaitingForSchedule') {
    return 'Очікується публікація графіка';
  }
  const offIntervals = day.intervals.filter((it) => it.status === 'off');
  if (offIntervals.length === 0) {
    return 'Без відключень (світло весь день)';
  }
  return offIntervals.map((it) => `${it.start}–${it.end}`).join(', ');
}

/**
 * Normalizes DTEK / Baskerville42 outage-data-ua hourly map ("1".."24" -> "yes"|"no"|"first"|"second"|"maybe")
 * into a 48-slot DaySchedule.
 * Note: hour key "1" is 00:00-01:00, hour key "24" is 23:00-24:00.
 */
export function parseDtekFactDay(
  hourMap: Record<string, string> | undefined,
  timestampSeconds: number,
  dateKey: string,
  updatedAt?: string
): DaySchedule {
  const slots: HalfHourSlotStatus[] = new Array(48).fill('on');

  if (!hourMap || Object.keys(hourMap).length === 0) {
    const intervals = buildIntervalsFromSlots(slots);
    return {
      dateKey,
      timestamp: timestampSeconds,
      status: 'WaitingForSchedule',
      slots,
      intervals,
      totalOnHours: 24,
      totalOffHours: 0,
      updatedAt,
    };
  }

  for (let hour = 1; hour <= 24; hour++) {
    const val = (hourMap[String(hour)] || 'yes').toLowerCase();
    const firstSlotIdx = (hour - 1) * 2;
    const secondSlotIdx = firstSlotIdx + 1;

    if (val === 'no') {
      slots[firstSlotIdx] = 'off';
      slots[secondSlotIdx] = 'off';
    } else if (val === 'first') {
      slots[firstSlotIdx] = 'off';
      slots[secondSlotIdx] = 'on';
    } else if (val === 'second') {
      slots[firstSlotIdx] = 'on';
      slots[secondSlotIdx] = 'off';
    } else if (val === 'maybe' || val === 'mfirst' || val === 'msecond') {
      slots[firstSlotIdx] = val === 'msecond' ? 'on' : 'maybe';
      slots[secondSlotIdx] = val === 'mfirst' ? 'on' : 'maybe';
    } else {
      slots[firstSlotIdx] = 'on';
      slots[secondSlotIdx] = 'on';
    }
  }

  const intervals = buildIntervalsFromSlots(slots);
  const offCount = slots.filter((s) => s === 'off').length;
  const totalOffHours = offCount * 0.5;
  const totalOnHours = 24 - totalOffHours;

  return {
    dateKey,
    timestamp: timestampSeconds,
    status: 'ScheduleApplies',
    slots,
    intervals,
    totalOnHours,
    totalOffHours,
    updatedAt,
  };
}

export interface YasnoRawSlot {
  start: number; // minutes from 0 to 1440
  end: number;
  type: 'Definite' | 'NotPlanned' | string;
}

export interface YasnoRawDay {
  slots: YasnoRawSlot[];
  date: string;
  status: string;
}

/**
 * Normalizes YASNO API v2 day object into a 48-slot DaySchedule
 */
export function parseYasnoDay(
  rawDay: YasnoRawDay | undefined,
  fallbackDateKey: string,
  updatedOn?: string
): DaySchedule {
  const slots: HalfHourSlotStatus[] = new Array(48).fill('on');

  if (!rawDay) {
    return {
      dateKey: fallbackDateKey,
      timestamp: Math.floor(Date.now() / 1000),
      status: 'WaitingForSchedule',
      slots,
      intervals: buildIntervalsFromSlots(slots),
      totalOnHours: 24,
      totalOffHours: 0,
      updatedAt: updatedOn,
    };
  }

  const dateKey = rawDay.date ? rawDay.date.slice(0, 10) : fallbackDateKey;
  const status: DayScheduleStatus =
    rawDay.status === 'EmergencyShutdowns'
      ? 'EmergencyShutdowns'
      : rawDay.status === 'WaitingForSchedule'
      ? 'WaitingForSchedule'
      : 'ScheduleApplies';

  if (Array.isArray(rawDay.slots) && rawDay.slots.length > 0) {
    for (const s of rawDay.slots) {
      const startSlot = Math.max(0, Math.floor(s.start / 30));
      const endSlot = Math.min(48, Math.ceil(s.end / 30));
      const slotStatus: HalfHourSlotStatus =
        s.type === 'Definite' ? 'off' : s.type === 'NotPlanned' ? 'on' : 'maybe';
      for (let idx = startSlot; idx < endSlot; idx++) {
        slots[idx] = slotStatus;
      }
    }
  }

  const intervals = buildIntervalsFromSlots(slots);
  const offCount = slots.filter((s) => s === 'off').length;
  const totalOffHours = offCount * 0.5;
  const totalOnHours = 24 - totalOffHours;

  return {
    dateKey,
    timestamp: rawDay.date ? Math.floor(new Date(rawDay.date).getTime() / 1000) : 0,
    status,
    slots,
    intervals,
    totalOnHours,
    totalOffHours,
    updatedAt: updatedOn,
  };
}

/**
 * Gets current Kyiv date ("YYYY-MM-DD"), tomorrow ("YYYY-MM-DD"), and current minutes from midnight (0..1439)
 */
export function getKyivTimeContext(now: Date = new Date()): {
  todayDateKey: string;
  tomorrowDateKey: string;
  nowMinutes: number;
  currentTimeStr: string;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Kyiv',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const parts = formatter.formatToParts(now);
  const partMap: Record<string, string> = {};
  for (const p of parts) {
    partMap[p.type] = p.value;
  }

  const year = partMap.year;
  const month = partMap.month;
  const day = partMap.day;
  const hour = parseInt(partMap.hour || '0', 10) % 24;
  const minute = parseInt(partMap.minute || '0', 10);

  const todayDateKey = `${year}-${month}-${day}`;

  const tomorrowDate = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const tomParts = formatter.formatToParts(tomorrowDate);
  const tomMap: Record<string, string> = {};
  for (const p of tomParts) {
    tomMap[p.type] = p.value;
  }
  const tomorrowDateKey = `${tomMap.year}-${tomMap.month}-${tomMap.day}`;

  const nowMinutes = hour * 60 + minute;
  const currentTimeStr = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;

  return {
    todayDateKey,
    tomorrowDateKey,
    nowMinutes,
    currentTimeStr,
  };
}

/**
 * Kyiv calendar date ("YYYY-MM-DD") of a unix timestamp in seconds.
 * Outage-Data-UA keys its days by Kyiv local midnight (e.g. 1794175200 = 2026-11-08T22:00Z = 2026-11-09 00:00 Kyiv).
 */
export function kyivDateKeyFromTimestamp(seconds: number): string {
  return getKyivTimeContext(new Date(seconds * 1000)).todayDateKey;
}

/**
 * Placeholder day for "schedule not published yet / data is stale".
 */
export function makeWaitingDay(dateKey: string): DaySchedule {
  return parseDtekFactDay(undefined, 0, dateKey);
}

/**
 * Re-labels a (possibly cached) GroupSchedule against the current Kyiv date, so data
 * from before midnight is never presented as "today":
 *  - today matches        -> unchanged
 *  - cached tomorrow == today -> promoted to today (midnight rollover while offline / between refreshes)
 *  - anything else        -> "waiting for schedule" instead of a wrong day
 */
export function rolloverGroupSchedule(
  g: GroupSchedule,
  todayDateKey: string,
  tomorrowDateKey: string
): GroupSchedule {
  if (g.today.dateKey === todayDateKey) {
    return g.tomorrow.dateKey === tomorrowDateKey
      ? g
      : { ...g, tomorrow: makeWaitingDay(tomorrowDateKey) };
  }
  if (g.tomorrow.dateKey === todayDateKey) {
    return { ...g, today: g.tomorrow, tomorrow: makeWaitingDay(tomorrowDateKey) };
  }
  return {
    ...g,
    today: makeWaitingDay(todayDateKey),
    tomorrow: makeWaitingDay(tomorrowDateKey),
  };
}

export function formatDurationHours(hours: number): string {
  return hours % 1 === 0 ? `${hours} год` : `${hours.toFixed(1)} год`;
}

/** Duration for notification texts, Ukrainian decimal comma: «4 год», «3,5 год». */
export function formatHoursUk(hours: number): string {
  return formatDurationHours(Math.round(hours * 10) / 10).replace('.', ',');
}

/** Cuts a text to `max` characters, ending with «…» when something was removed. */
export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** Fixed texts of the «notifications work» test push (server, local and sample script share them). */
export const TEST_PUSH_TITLE = '✅ Сповіщення працюють';
export const TEST_PUSH_BODY = 'Попередимо за ~30 хв до відключення та увімкнення.';

/**
 * Name shown in notification titles. It deliberately does NOT contain street or house number:
 * pushes (and the synced subscriber record, which lives in a public repo) must not expose the address.
 *  1. `shortTitle` if present (already computed, e.g. on a synced record)
 *  2. the user's own address name when it is a short alias like "Дім", "Дача", "Офіс"
 *     (<= 20 chars, no digits/commas, i.e. not an address line)
 *  3. otherwise the settlement: "с. Гатне" for the oblast, "Київ" for Kyiv
 */
export function getShortAddress(address: SavedAddress): string {
  if (address.shortTitle && address.shortTitle.trim()) return address.shortTitle.trim();
  const alias = (address.label || '').trim();
  if (alias && alias.length <= 20 && !/[\d,]/.test(alias)) return alias;
  if (address.region === 'krem' && address.city) {
    const clean = address.city.replace(/\s*\([^)]*\)\s*/g, '').trim();
    if (clean && !clean.toLowerCase().includes('київ')) return clean;
  }
  return 'Київ';
}

/**
 * Record that is synced to the push worker: everything the worker needs, nothing that identifies the address.
 */
export function toSyncAddress(address: SavedAddress): SavedAddress {
  return {
    id: address.id,
    label: '',
    icon: '',
    region: address.region,
    city: '',
    street: '',
    house: '',
    group: address.group,
    notifyBeforeOff: address.notifyBeforeOff,
    notifyBeforeOn: address.notifyBeforeOn,
    notifyOnChange: address.notifyOnChange,
    createdAt: address.createdAt,
    shortTitle: getShortAddress(address),
  };
}

export interface CurrentStatusSummary {
  state: 'on' | 'off' | 'emergency' | 'waiting';
  headline: string;
  subline: string;
  badgeText: string;
  targetTime?: string;
  /** true when `targetTime` (restoration) falls on tomorrow, i.e. the outage continues past midnight */
  targetIsTomorrow?: boolean;
  currentInterval: TimeInterval | null;
  /** Next interval of the *opposite* kind to the current one (kept for backwards compatibility) */
  nextInterval: TimeInterval | null;
  nextDayInterval: boolean;
  /** Next OUTAGE after now (when light is on) or after restoration (when light is off) */
  nextOutage: TimeInterval | null;
  nextOutageIsTomorrow: boolean;
}

function findNextOutage(
  groupSchedule: GroupSchedule,
  afterAbsMinutes: number
): { interval: TimeInterval; isTomorrow: boolean } | null {
  const { today, tomorrow } = groupSchedule;
  for (const it of today.intervals) {
    if (it.status === 'off' && it.startMinutes > afterAbsMinutes) {
      return { interval: it, isTomorrow: false };
    }
  }
  if (tomorrow.status === 'ScheduleApplies') {
    for (const it of tomorrow.intervals) {
      if (it.status === 'off' && 1440 + it.startMinutes > afterAbsMinutes) {
        return { interval: it, isTomorrow: true };
      }
    }
  }
  return null;
}

/**
 * Computes the clear status summary for HeroStatusCard (without a countdown timer, per user preference)
 */
export function getCurrentAddressStatus(
  groupSchedule: GroupSchedule | undefined,
  nowMinutes: number
): CurrentStatusSummary {
  const base = {
    currentInterval: null,
    nextInterval: null,
    nextDayInterval: false,
    nextOutage: null,
    nextOutageIsTomorrow: false,
  };

  if (!groupSchedule) {
    return {
      ...base,
      state: 'waiting',
      headline: 'Завантаження графіка…',
      subline: 'Отримуємо актуальні дані ДТЕК',
      badgeText: 'графік очікується',
    };
  }

  const { today, tomorrow } = groupSchedule;

  if (today.status === 'EmergencyShutdowns') {
    return {
      ...base,
      state: 'emergency',
      headline: 'Екстрені відключення',
      subline:
        groupSchedule.emergencyNote ||
        'У регіоні діють екстрені або аварійні відключення поза графіком',
      badgeText: 'екстрені відключення',
    };
  }

  // No published data for today: never claim "light is on" from a placeholder of all-"on" slots.
  if (today.status === 'WaitingForSchedule') {
    return {
      ...base,
      state: 'waiting',
      headline: 'Графік очікується',
      subline: 'ДТЕК ще не опублікував графік на сьогодні',
      badgeText: 'графік очікується',
    };
  }

  const currentInterval =
    today.intervals.find(
      (it) => nowMinutes >= it.startMinutes && nowMinutes < it.endMinutes
    ) || today.intervals[today.intervals.length - 1] || null;

  const isCurrentlyOff = currentInterval?.status === 'off';

  // Find next opposite interval today or tomorrow
  const nextIntervalToday =
    today.intervals.find(
      (it) =>
        it.startMinutes > nowMinutes &&
        it.status !== (isCurrentlyOff ? 'off' : 'on')
    ) || null;

  let nextInterval = nextIntervalToday;
  let nextDayInterval = false;

  if (!nextInterval && tomorrow.status === 'ScheduleApplies') {
    const firstOppositeTomorrow = tomorrow.intervals.find(
      (it) => it.status === (isCurrentlyOff ? 'on' : 'off')
    );
    if (firstOppositeTomorrow) {
      nextInterval = firstOppositeTomorrow;
      nextDayInterval = true;
    }
  }

  if (isCurrentlyOff && currentInterval) {
    // An outage that runs up to 24:00 and continues in tomorrow's first slot is ONE outage:
    // report the real restoration time instead of "до 24:00".
    let restoreTime = currentInterval.end;
    let restoreAbs = currentInterval.endMinutes;
    let restoreIsTomorrow = false;
    if (currentInterval.endMinutes >= 1440 && tomorrow.status === 'ScheduleApplies') {
      const first = tomorrow.intervals[0];
      if (first && first.status === 'off') {
        restoreTime = first.end;
        restoreAbs = 1440 + first.endMinutes;
        restoreIsTomorrow = true;
      }
    }

    const nextOut = findNextOutage(groupSchedule, restoreAbs);
    return {
      state: 'off',
      headline: 'Відключення за графіком',
      subline: `Слот відключення ${currentInterval.start} – ${currentInterval.end} • Включення ${
        restoreIsTomorrow ? 'завтра ' : ''
      }о ${restoreTime}`,
      badgeText: `немає світла до ${restoreTime}${restoreIsTomorrow ? ' (завтра)' : ''}`,
      targetTime: restoreTime,
      targetIsTomorrow: restoreIsTomorrow,
      currentInterval,
      nextInterval,
      nextDayInterval,
      nextOutage: nextOut?.interval ?? null,
      nextOutageIsTomorrow: nextOut?.isTomorrow ?? false,
    };
  }

  // Currently ON
  const nextOut = findNextOutage(groupSchedule, nowMinutes);
  if (nextOut) {
    const dayPrefix = nextOut.isTomorrow ? 'Завтра ' : '';
    return {
      state: 'on',
      headline: 'Світло є',
      subline: `Наступне відключення: ${dayPrefix}${nextOut.interval.start} – ${nextOut.interval.end}`,
      badgeText: `є світло до ${nextOut.interval.start}`,
      targetTime: nextOut.interval.start,
      targetIsTomorrow: nextOut.isTomorrow,
      currentInterval,
      nextInterval,
      nextDayInterval,
      nextOutage: nextOut.interval,
      nextOutageIsTomorrow: nextOut.isTomorrow,
    };
  }

  return {
    state: 'on',
    headline: 'Світло є',
    subline: 'Сьогодні відключень більше не заплановано',
    badgeText: 'є світло',
    currentInterval,
    nextInterval: null,
    nextDayInterval: false,
    nextOutage: null,
    nextOutageIsTomorrow: false,
  };
}

/**
 * Compares previous and new DaySchedule to detect intraday schedule modifications
 */
export function computeScheduleDiff(
  prevDay: DaySchedule | undefined,
  nextDay: DaySchedule,
  dayLabel: 'Сьогодні' | 'Завтра'
): ScheduleDiffResult {
  const previousSummary = prevDay ? summarizeOffIntervals(prevDay) : '';
  const currentSummary = summarizeOffIntervals(nextDay);

  if (!prevDay || prevDay.dateKey !== nextDay.dateKey) {
    return {
      hasChanged: false,
      dayLabel,
      dateKey: nextDay.dateKey,
      previousSummary,
      currentSummary,
      summaryText: '',
    };
  }

  const prevSlotsKey = `${prevDay.status}:${prevDay.slots.join(',')}`;
  const nextSlotsKey = `${nextDay.status}:${nextDay.slots.join(',')}`;

  if (prevSlotsKey === nextSlotsKey) {
    return {
      hasChanged: false,
      dayLabel,
      dateKey: nextDay.dateKey,
      previousSummary,
      currentSummary,
      summaryText: '',
    };
  }

  return {
    hasChanged: true,
    dayLabel,
    dateKey: nextDay.dateKey,
    previousSummary,
    currentSummary,
    summaryText: `${dayLabel}: було (${previousSummary}) → стало (${currentSummary})`,
  };
}

/**
 * Checks if current Kyiv time falls within Quiet Hours (e.g. 23:00 to 07:00)
 */
export function isWithinQuietHours(
  nowMinutes: number,
  enabled: boolean,
  startStr: string = '23:00',
  endStr: string = '07:00'
): boolean {
  if (!enabled) return false;
  const [sh, sm] = startStr.split(':').map((n) => parseInt(n, 10) || 0);
  const [eh, em] = endStr.split(':').map((n) => parseInt(n, 10) || 0);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;

  if (startMin <= endMin) {
    return nowMinutes >= startMin && nowMinutes < endMin;
  }
  // Crosses midnight (e.g., 23:00 -> 07:00)
  return nowMinutes >= startMin || nowMinutes < endMin;
}


/**
 * Evaluates the [10..42] minute sliding window for ~30-minute warnings before outage start and restoration,
 * using deterministic eventId deduplication so GitHub Actions cron jitter never misses or duplicates an alert.
 *
 * Outages are treated as continuous episodes across midnight when `tomorrowSchedule` is known
 * (e.g. 22:00-24:00 today + 00:00-04:00 tomorrow is a single 6 h outage restored at 04:00), so that
 *  - an outage beginning exactly at 00:00 tomorrow still gets its pre-warning,
 *  - no bogus "restoration at 24:00" warning is produced for an outage that actually continues.
 * Event ids are keyed by the calendar day the event happens on, so the same event gets the same id
 * whether it is first seen from "today's" or from "yesterday's" evaluation.
 *
 * Texts name the clock time of the event, not a lead time: with a 10..42 min window the
 * notification can legitimately arrive anywhere in that range, so «за 30 хв» would often be wrong.
 */
export function evaluateUpcomingAlerts(
  address: SavedAddress,
  todaySchedule: DaySchedule,
  nowMinutes: number,
  notifiedEvents: Record<string, string>,
  windowMin: number = 10,
  windowMax: number = 42,
  tomorrowSchedule?: DaySchedule
): UpcomingAlertTrigger[] {
  const triggers: UpcomingAlertTrigger[] = [];
  if (todaySchedule.status !== 'ScheduleApplies') {
    return triggers;
  }

  const days: DaySchedule[] = [todaySchedule];
  if (tomorrowSchedule && tomorrowSchedule.status === 'ScheduleApplies') {
    days.push(tomorrowSchedule);
  }
  const horizon = days.length * 1440;

  // Absolute minutes (0 = today 00:00, 1440 = tomorrow 00:00) -> owning day + local minutes
  const locate = (abs: number): { day: DaySchedule; local: number } => {
    const idx = Math.min(days.length - 1, Math.floor(abs / 1440));
    return { day: days[idx], local: abs - idx * 1440 };
  };

  // Build continuous outage episodes, merging across the midnight boundary
  const episodes: Array<{ startAbs: number; endAbs: number }> = [];
  days.forEach((day, dayIdx) => {
    for (const it of day.intervals) {
      if (it.status !== 'off') continue;
      const startAbs = dayIdx * 1440 + it.startMinutes;
      const endAbs = dayIdx * 1440 + it.endMinutes;
      const last = episodes[episodes.length - 1];
      if (last && last.endAbs === startAbs) {
        last.endAbs = endAbs;
      } else {
        episodes.push({ startAbs, endAbs });
      }
    }
  });

  // Continuous periods with light, merged across midnight like the outage episodes
  const lightRuns: Array<{ startAbs: number; endAbs: number }> = [];
  days.forEach((day, dayIdx) => {
    for (const it of day.intervals) {
      if (it.status !== 'on') continue;
      const startAbs = dayIdx * 1440 + it.startMinutes;
      const endAbs = dayIdx * 1440 + it.endMinutes;
      const last = lightRuns[lightRuns.length - 1];
      if (last && last.endAbs === startAbs) {
        last.endAbs = endAbs;
      } else {
        lightRuns.push({ startAbs, endAbs });
      }
    }
  });

  // «до 20:00» / «до завтра 04:00»: the end is on a later calendar day than the start of the period
  const untilText = (startAbs: number, endAbs: number): string => {
    const endDay = Math.ceil(endAbs / 1440) - 1;
    const startDay = Math.floor(startAbs / 1440);
    const t = formatMinutesToTime(endAbs - endDay * 1440);
    return `до ${endDay > startDay ? 'завтра ' : ''}${t}`;
  };

  const shortAddr = getShortAddress(address);

  for (const ep of episodes) {
    const start = locate(ep.startAbs);
    const end = locate(ep.endAbs);
    const startStr = formatMinutesToTime(start.local);
    const endStr = formatMinutesToTime(end.local);

    // 1. Warning before outage starts (an outage already running at 00:00 today has no start to warn about)
    if (address.notifyBeforeOff && ep.startAbs > 0) {
      const diffToStart = ep.startAbs - nowMinutes;
      const eventId = `${address.id}:${start.day.dateKey}:before_off:${start.local}`;
      if (
        diffToStart >= windowMin &&
        diffToStart <= windowMax &&
        !notifiedEvents[eventId]
      ) {
        triggers.push({
          eventId,
          addressId: address.id,
          addressLabel: address.label,
          addressIcon: address.icon,
          group: address.group,
          type: 'before_off',
          targetMinutes: start.local,
          targetTimeStr: startStr,
          intervalStr: `${startStr} – ${endStr}`,
          minutesRemaining: diffToStart,
          title: `🪫 ${startStr} вимкнення`,
          body: `${shortAddr} · ${untilText(ep.startAbs, ep.endAbs)} · ${formatHoursUk(
            (ep.endAbs - ep.startAbs) / 60
          )} без світла`,
          icon: './icon-off.svg',
        });
      }
    }

    // 2. Warning before outage ends (power restoration); unknown beyond the last known day
    if (address.notifyBeforeOn && ep.endAbs < horizon) {
      const diffToEnd = ep.endAbs - nowMinutes;
      const eventId = `${address.id}:${end.day.dateKey}:before_on:${end.local}`;
      if (
        diffToEnd >= windowMin &&
        diffToEnd <= windowMax &&
        !notifiedEvents[eventId]
      ) {
        // The period with light that starts right when this outage ends
        const run = lightRuns.find((r) => r.startAbs === ep.endAbs);
        const bodyText = run
          ? `${shortAddr} · ${untilText(run.startAbs, run.endAbs)} · ${formatHoursUk(
              (run.endAbs - run.startAbs) / 60
            )} зі світлом`
          : `${shortAddr} · далі можливі відключення`;

        triggers.push({
          eventId,
          addressId: address.id,
          addressLabel: address.label,
          addressIcon: address.icon,
          group: address.group,
          type: 'before_on',
          targetMinutes: end.local,
          targetTimeStr: endStr,
          intervalStr: `${startStr} – ${endStr}`,
          minutesRemaining: diffToEnd,
          title: `🔋 ${endStr} увімкнення`,
          body: bodyText,
          icon: './icon-on.svg',
        });
      }
    }
  }

  return triggers;
}

/** One day whose published schedule changed (input of {@link buildChangeNotification}). */
export interface ScheduleChange {
  dayLabel: 'Сьогодні' | 'Завтра';
  prev: DaySchedule;
  next: DaySchedule;
}

const intervalRanges = (
  day: DaySchedule,
  status: HalfHourSlotStatus,
  filterMin?: number
): string =>
  day.intervals
    .filter((it) => it.status === status && (filterMin === undefined || it.endMinutes > filterMin))
    .map((it) => `${it.start}–${it.end}`)
    .join(', ');

/** What the schedule says now, lower-case start: «відключення 16:00–20:00», «без відключень» … */
function nowText(day: DaySchedule, filterMin?: number): string {
  if (day.status === 'EmergencyShutdowns') return 'екстрені відключення';
  if (day.status === 'WaitingForSchedule') return 'графік очікується';
  const off = intervalRanges(day, 'off', filterMin);
  const maybe = intervalRanges(day, 'maybe', filterMin);
  if (!off && !maybe) return 'без відключень';
  if (!off) return `можливі відключення ${maybe}`;
  return `відключення ${off}${maybe ? `, можливі ${maybe}` : ''}`;
}

/** What it said before («було …»); null when there was no schedule to compare with. */
function wasText(day: DaySchedule, filterMin?: number): string | null {
  if (day.status === 'WaitingForSchedule') return null;
  if (day.status === 'EmergencyShutdowns') return 'екстрені відключення';
  const off = intervalRanges(day, 'off', filterMin);
  const maybe = intervalRanges(day, 'maybe', filterMin);
  if (!off && !maybe) return 'без відключень';
  return [off, maybe && `можливі ${maybe}`].filter(Boolean).join(', ');
}

const CHANGE_BODY_MAX = 110;

/**
 * Title and body of the «schedule changed» push. Short and about the schedule only:
 *  «Відключення 16:00–20:00 (було 14:00–18:00)»; both days → one line per day.
 * A tomorrow schedule that was simply not published before is announced as published, not as «changed».
 * When nowMinutes is provided, intervals for today that have already ended are omitted from the text,
 * so the push focuses on the current and upcoming situation rather than past events.
 */
export function buildChangeNotification(
  shortAddr: string,
  changes: ScheduleChange[],
  nowMinutes?: number
): { title: string; body: string } {
  const line = (c: ScheduleChange, prefix: string | null): string => {
    const filterMin = c.dayLabel === 'Сьогодні' ? nowMinutes : undefined;
    let was = wasText(c.prev, filterMin);
    let now = nowText(c.next, filterMin);

    // If filtering past intervals wiped out the visible difference between prev and next,
    // fall back to the full day so the user still sees what changed.
    if (filterMin !== undefined && was === now) {
      was = wasText(c.prev);
      now = nowText(c.next);
    }

    // «було екстрені відключення» is ungrammatical and, after a line wrap, reads as if the last
    // interval itself was the emergency one — so that case gets its own wording.
    const wasPhrase =
      c.prev.status === 'EmergencyShutdowns' ? 'замість екстрених відключень' : `було ${was}`;
    const text = was && was !== now ? `${now} (${wasPhrase})` : now;
    return prefix ? `${prefix}: ${text}` : text;
  };

  if (changes.length === 1) {
    const c = changes[0];
    const dayWord = c.dayLabel === 'Завтра' ? 'завтра' : 'сьогодні';
    const published =
      c.prev.status === 'WaitingForSchedule' && c.next.status === 'ScheduleApplies';
    return {
      // Short title: the iPhone cuts it at ~14–15 characters when the push is a few minutes old
      title: published ? `🗓️ Графік на ${dayWord}` : '🗓️ Графік змінено',
      body: truncateText(
        `${shortAddr} · ${published ? '' : `${dayWord}: `}${line(c, null)}`,
        CHANGE_BODY_MAX
      ),
    };
  }

  const perLine = Math.floor(CHANGE_BODY_MAX / Math.max(1, changes.length)) - 1;
  return {
    title: '🗓️ Графік змінено',
    body: [shortAddr, ...changes.map((c) => truncateText(line(c, c.dayLabel), perLine))].join('\n'),
  };
}
