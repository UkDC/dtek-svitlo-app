import { HalfHourSlotStatus } from './scheduleNormalizer';

/**
 * Geometry of the «Кільце доби»: a 12-hour clock dial that makes two laps per day.
 * Inner ring = 00:00–12:00, outer ring = 12:00–24:00; 12 at the top, clockwise.
 */
export const RING_SIZE = 320;
export const RING_CENTER = RING_SIZE / 2;
export const RING_STROKE = 20;
export const RING_RADIUS_INNER = 97; // lap 0: 00:00–12:00
export const RING_RADIUS_OUTER = 122; // lap 1: 12:00–24:00
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_LAP = 720;

export type RingLap = 0 | 1;

export const ringRadius = (lap: RingLap): number => (lap === 0 ? RING_RADIUS_INNER : RING_RADIUS_OUTER);
export const ringCircumference = (lap: RingLap): number => 2 * Math.PI * ringRadius(lap);

/** A contiguous same-status run within the day. */
export interface RingArc {
  status: HalfHourSlotStatus;
  startMinutes: number;
  endMinutes: number;
}

/** A drawable arc on one of the two rings. */
export interface LapArc {
  lap: RingLap;
  status: HalfHourSlotStatus;
  startMinutes: number;
  endMinutes: number;
  /** stroke-dasharray first value: arc length in SVG units for this ring's radius */
  length: number;
  /** stroke-dashoffset (negative: shifts the dash clockwise from 12 o'clock) */
  offset: number;
  /** full circumference of this ring (second dasharray value) */
  circumference: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Merges the 48 half-hour slots into contiguous same-status runs over the whole day (before the 12:00 split). */
export function buildRingArcs(slots: HalfHourSlotStatus[]): RingArc[] {
  if (!slots || slots.length === 0) return [];
  const slotMinutes = MINUTES_PER_DAY / slots.length;
  const arcs: RingArc[] = [];
  let runStart = 0;
  for (let i = 1; i <= slots.length; i++) {
    if (i === slots.length || slots[i] !== slots[runStart]) {
      const startMinutes = runStart * slotMinutes;
      const endMinutes = i * slotMinutes;
      arcs.push({
        status: slots[runStart],
        startMinutes,
        endMinutes,
      });
      runStart = i;
    }
  }
  return arcs;
}

/** Splits the day's runs at 12:00 and converts each part into an arc on its own ring. */
export function buildLapArcs(slots: HalfHourSlotStatus[]): LapArc[] {
  const out: LapArc[] = [];
  for (const run of buildRingArcs(slots)) {
    for (const lap of [0, 1] as RingLap[]) {
      const lapStart = lap * MINUTES_PER_LAP;
      const start = Math.max(run.startMinutes, lapStart);
      const end = Math.min(run.endMinutes, lapStart + MINUTES_PER_LAP);
      if (end <= start) continue;
      const c = ringCircumference(lap);
      out.push({
        lap,
        status: run.status,
        startMinutes: start,
        endMinutes: end,
        length: round2(((end - start) / MINUTES_PER_LAP) * c),
        offset: -round2(((start - lapStart) / MINUTES_PER_LAP) * c),
        circumference: c,
      });
    }
  }
  return out;
}

/** Point at `fraction` of a lap (0 = 12 o'clock, clockwise) on a circle of the given radius. */
export function polar(radius: number, fraction: number): { x: number; y: number } {
  const angle = fraction * 2 * Math.PI;
  return {
    x: round2(RING_CENTER + radius * Math.sin(angle)),
    y: round2(RING_CENTER - radius * Math.cos(angle)),
  };
}

/** Lap and clock-face fraction (0..1) for a time of day. 24:00 is clamped just before the end of lap 1. */
export function dialPosition(nowMinutes: number): { lap: RingLap; fraction: number } {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY - 0.01, nowMinutes));
  const lap: RingLap = clamped >= MINUTES_PER_LAP ? 1 : 0;
  return { lap, fraction: (clamped % MINUTES_PER_LAP) / MINUTES_PER_LAP };
}

/** Position of the «now» marker on the ring of the current lap (viewBox coordinates). */
export function ringMarkerPosition(nowMinutes: number): { x: number; y: number; lap: RingLap } {
  const { lap, fraction } = dialPosition(nowMinutes);
  return { ...polar(ringRadius(lap), fraction), lap };
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
