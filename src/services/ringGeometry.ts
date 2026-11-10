import { HalfHourSlotStatus } from './scheduleNormalizer';

/**
 * Geometry of the «Кільце доби» (variant G+): a 12-hour clock dial.
 *  - Main ring = the current half of the day (00–12 or 12–24): the past part is dimmed,
 *    the remainder up to the end of the half is bright; 12 at the top, clockwise.
 *  - Thin outer track = what comes next: before noon → today's 12–24, after noon → tomorrow's 00–12
 *    (or a placeholder when tomorrow's schedule is not published).
 */
export const RING_SIZE = 320;
export const RING_CENTER = RING_SIZE / 2;
export const RING_RADIUS_MAIN = 108;
export const RING_STROKE_MAIN = 34;
export const RING_RADIUS_TRACK = 139;
export const RING_STROKE_TRACK = 8;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HALF = 720;

export type DialHalf = 0 | 1;

export const circumferenceOf = (radius: number): number => 2 * Math.PI * radius;

/** A contiguous same-status run within the day. */
export interface RingArc {
  status: HalfHourSlotStatus;
  startMinutes: number;
  endMinutes: number;
}

/** A drawable arc on the main ring or on the thin track. */
export interface DialArc {
  status: HalfHourSlotStatus;
  /** Minutes since midnight of the day the arc belongs to */
  startMinutes: number;
  endMinutes: number;
  /** True when the arc lies entirely before «now» (drawn dimmed) */
  past: boolean;
  /** stroke-dasharray first value: arc length for this ring's radius */
  length: number;
  /** stroke-dashoffset (negative: shifts the dash clockwise from 12 o'clock) */
  offset: number;
  /** full circumference of this ring (second dasharray value) */
  circumference: number;
}

export interface DialHourLabel {
  text: string;
  /** Position on the face, 0..1 of a half, 0 = 12 o'clock */
  fraction: number;
}

export interface DialPlan {
  /** Which half the main ring shows: 0 = 00–12, 1 = 12–24 */
  half: DialHalf;
  main: DialArc[];
  /** null = no data for the track → draw the dashed placeholder */
  track: DialArc[] | null;
  /** Hour of the day where the track starts (12 or 0) — for tests / debugging */
  trackStartMinutes: number;
  /** Real 24-hour digits for the current half: 00/03/06/09 or 12/15/18/21 */
  hourLabels: DialHourLabel[];
  /** «now» hand and marker; null when nowMinutes is null */
  nowFraction: number | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Merges the 48 half-hour slots into contiguous same-status runs over the whole day. */
export function buildRingArcs(slots: HalfHourSlotStatus[]): RingArc[] {
  if (!slots || slots.length === 0) return [];
  const slotMinutes = MINUTES_PER_DAY / slots.length;
  const arcs: RingArc[] = [];
  let runStart = 0;
  for (let i = 1; i <= slots.length; i++) {
    if (i === slots.length || slots[i] !== slots[runStart]) {
      arcs.push({
        status: slots[runStart],
        startMinutes: runStart * slotMinutes,
        endMinutes: i * slotMinutes,
      });
      runStart = i;
    }
  }
  return arcs;
}

/**
 * Cuts the day's runs to a 12-hour window and converts them to drawable arcs on a ring of the given radius.
 * If `splitAt` falls inside a run, the run is cut there so the past part can be dimmed.
 */
function windowArcs(
  slots: HalfHourSlotStatus[],
  windowStart: number,
  radius: number,
  splitAt: number | null
): DialArc[] {
  const c = circumferenceOf(radius);
  const windowEnd = windowStart + MINUTES_PER_HALF;
  const out: DialArc[] = [];

  const push = (status: HalfHourSlotStatus, start: number, end: number, past: boolean) => {
    if (end <= start) return;
    out.push({
      status,
      startMinutes: start,
      endMinutes: end,
      past,
      length: round2(((end - start) / MINUTES_PER_HALF) * c),
      offset: -round2(((start - windowStart) / MINUTES_PER_HALF) * c),
      circumference: c,
    });
  };

  for (const run of buildRingArcs(slots)) {
    const start = Math.max(run.startMinutes, windowStart);
    const end = Math.min(run.endMinutes, windowEnd);
    if (end <= start) continue;
    if (splitAt !== null && splitAt > start && splitAt < end) {
      push(run.status, start, splitAt, true);
      push(run.status, splitAt, end, false);
    } else {
      push(run.status, start, end, splitAt !== null && end <= splitAt);
    }
  }
  return out;
}

/** Point at `fraction` of a half (0 = 12 o'clock, clockwise) on a circle of the given radius. */
export function polar(radius: number, fraction: number): { x: number; y: number } {
  const angle = fraction * 2 * Math.PI;
  return {
    x: round2(RING_CENTER + radius * Math.sin(angle)),
    y: round2(RING_CENTER - radius * Math.cos(angle)),
  };
}

/** Half and clock-face fraction (0..1) for a time of day. 24:00 is clamped just before the end of the second half. */
export function dialPosition(nowMinutes: number): { half: DialHalf; fraction: number } {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 0.01, nowMinutes));
  const half: DialHalf = clamped >= MINUTES_PER_HALF ? 1 : 0;
  return { half, fraction: (clamped % MINUTES_PER_HALF) / MINUTES_PER_HALF };
}

/** Position of the «now» marker on the main ring (viewBox coordinates). */
export function ringMarkerPosition(nowMinutes: number): { x: number; y: number; half: DialHalf } {
  const { half, fraction } = dialPosition(nowMinutes);
  return { ...polar(RING_RADIUS_MAIN, fraction), half };
}

/** 24-hour digits for a half: 00/03/06/09 or 12/15/18/21. */
export function buildHourLabels(half: DialHalf): DialHourLabel[] {
  return [0, 1, 2, 3].map((k) => ({
    text: String(half * 12 + k * 3).padStart(2, '0'),
    fraction: k / 4,
  }));
}

/**
 * Plans what the dial draws.
 *  - nowMinutes != null (today): the main ring shows the half containing «now», split into dimmed past / bright remainder.
 *  - nowMinutes == null (tomorrow or any day without a «now»): main = 00–12, no dimming.
 *  - Track: first half → the same day's 12–24; second half → nextDaySlots' 00–12, or null when unavailable.
 */
export function planDial(input: {
  slots: HalfHourSlotStatus[];
  nowMinutes: number | null;
  nextDaySlots?: HalfHourSlotStatus[];
}): DialPlan {
  const { slots, nowMinutes, nextDaySlots } = input;
  const pos = nowMinutes === null ? null : dialPosition(nowMinutes);
  const half: DialHalf = pos ? pos.half : 0;
  const splitAt = nowMinutes === null ? null : Math.max(0, Math.min(MINUTES_PER_DAY, nowMinutes));

  const main = windowArcs(slots, half * MINUTES_PER_HALF, RING_RADIUS_MAIN, splitAt);

  let track: DialArc[] | null;
  let trackStartMinutes: number;
  if (half === 0) {
    trackStartMinutes = MINUTES_PER_HALF;
    track = windowArcs(slots, MINUTES_PER_HALF, RING_RADIUS_TRACK, null);
  } else {
    trackStartMinutes = 0;
    track = nextDaySlots && nextDaySlots.length > 0 ? windowArcs(nextDaySlots, 0, RING_RADIUS_TRACK, null) : null;
  }

  return {
    half,
    main,
    track,
    trackStartMinutes,
    hourLabels: buildHourLabels(half),
    nowFraction: pos ? pos.fraction : null,
  };
}

function fmt(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Screen-reader description of the whole day, e.g. «Доба: зі світлом 00:00–03:30, 09:30–12:30; без світла решту часу». */
export function buildRingAriaLabel(arcs: RingArc[]): string {
  if (arcs.length === 0) return 'Доба: графік відсутній';
  const range = (a: RingArc) => `${fmt(a.startMinutes)}–${a.endMinutes >= MINUTES_PER_DAY ? '24:00' : fmt(a.endMinutes)}`;
  const on = arcs.filter((a) => a.status === 'on');
  const off = arcs.filter((a) => a.status === 'off');
  const maybe = arcs.filter((a) => a.status === 'maybe');

  const parts: string[] = [];
  if (on.length === 0 && maybe.length === 0) return 'Доба: без світла весь день';
  if (off.length === 0 && maybe.length === 0) return 'Доба: світло є весь день';
  if (on.length > 0) parts.push(`зі світлом ${on.map(range).join(', ')}`);
  if (maybe.length > 0) parts.push(`можливі відключення ${maybe.map(range).join(', ')}`);
  if (off.length > 0) parts.push('без світла решту часу');
  return `Доба: ${parts.join('; ')}`;
}
