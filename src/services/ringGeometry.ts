import { HalfHourSlotStatus } from './scheduleNormalizer';

/**
 * Geometry of the «Кільце доби» (variant B): a 12-hour clock dial with two FIXED rings.
 *  - Inner ring = always 00–12, outer ring = always 12–24 of the shown day; 12 at the top, clockwise.
 *  - The half that contains «now» is drawn thick (active), the other one thin; the past is dimmed.
 *  - Without «now» (tomorrow tab) both rings have the same medium width and nothing is dimmed.
 * The rings never change meaning during the day — only the emphasis moves (H11).
 */
export const RING_SIZE = 320;
export const RING_CENTER = RING_SIZE / 2;
export const RING_RADIUS_INNER = 100;
export const RING_RADIUS_OUTER = 134;
export const RING_STROKE_ACTIVE = 30;
export const RING_STROKE_IDLE = 10;
/** Width of both rings when there is no «now» (tomorrow tab) */
export const RING_STROKE_EVEN = 20;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_HALF = 720;
/** Visible break of the outer ring at 12 o'clock (total, split evenly between its start and end) */
export const OUTER_GAP_MINUTES = 12;
/** Radius of the 00/03/06/09 digits (inside the inner ring) */
export const RING_RADIUS_INNER_LABEL = 61;
/** Radius of the 12/15/18/21 digits (outside the outer ring) */
export const RING_RADIUS_OUTER_LABEL = 160;
/** Extra room around the dial (viewBox units) so the outer digits are never clipped */
export const RING_PAD = 12;

export type DialHalf = 0 | 1;

export const circumferenceOf = (radius: number): number => 2 * Math.PI * radius;

/** A contiguous same-status run within the day. */
export interface RingArc {
  status: HalfHourSlotStatus;
  startMinutes: number;
  endMinutes: number;
}

/** A drawable arc on one of the two rings. */
export interface DialArc {
  status: HalfHourSlotStatus;
  /** Minutes since midnight of the shown day */
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

export interface DialRing {
  /** 0 = inner ring (00–12), 1 = outer ring (12–24) */
  half: DialHalf;
  radius: number;
  strokeWidth: number;
  /** True for the half that contains «now» */
  active: boolean;
  arcs: DialArc[];
  /** Real 24-hour digits of this half: 00/03/06/09 (inner) or 12/15/18/21 (outer) */
  hourLabels: DialHourLabel[];
}

export interface DialPlan {
  /** Half that contains «now»; null when there is no «now» (tomorrow tab) */
  activeHalf: DialHalf | null;
  inner: DialRing;
  outer: DialRing;
  /** «now» hand and marker position (0..1 of the active half); null when nowMinutes is null */
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
  splitAt: number | null,
  gapMinutes = 0
): DialArc[] {
  const c = circumferenceOf(radius);
  const from = windowStart + gapMinutes / 2;
  const windowEnd = windowStart + MINUTES_PER_HALF - gapMinutes / 2;
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
    const start = Math.max(run.startMinutes, from);
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

/** Radius of a ring: the inner one is always 00–12, the outer one always 12–24. */
export const ringRadius = (half: DialHalf): number => (half === 0 ? RING_RADIUS_INNER : RING_RADIUS_OUTER);

/** Position of the «now» marker: on the ring of the current half (viewBox coordinates). */
export function ringMarkerPosition(nowMinutes: number): { x: number; y: number; half: DialHalf } {
  const { half, fraction } = dialPosition(nowMinutes);
  return { ...polar(ringRadius(half), fraction), half };
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
 *  - Inner ring: the day's 00–12; outer ring: the day's 12–24 (with a small break at 12 o'clock).
 *  - nowMinutes != null (today): the half containing «now» is thick, the other thin; everything before «now» is dimmed.
 *  - nowMinutes == null (tomorrow or any day without a «now»): both rings medium width, nothing dimmed.
 */
export function planDial(input: { slots: HalfHourSlotStatus[]; nowMinutes: number | null }): DialPlan {
  const { slots, nowMinutes } = input;
  const pos = nowMinutes === null ? null : dialPosition(nowMinutes);
  const activeHalf: DialHalf | null = pos ? pos.half : null;
  const splitAt = nowMinutes === null ? null : Math.max(0, Math.min(MINUTES_PER_DAY, nowMinutes));

  const ring = (half: DialHalf): DialRing => {
    const radius = ringRadius(half);
    const active = activeHalf === half;
    return {
      half,
      radius,
      strokeWidth: activeHalf === null ? RING_STROKE_EVEN : active ? RING_STROKE_ACTIVE : RING_STROKE_IDLE,
      active,
      arcs: windowArcs(slots, half * MINUTES_PER_HALF, radius, splitAt, half === 1 ? OUTER_GAP_MINUTES : 0),
      hourLabels: buildHourLabels(half),
    };
  };

  return {
    activeHalf,
    inner: ring(0),
    outer: ring(1),
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
