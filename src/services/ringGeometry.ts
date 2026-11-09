import { HalfHourSlotStatus } from './scheduleNormalizer';

/** Geometry of the «Кільце доби» (24-hour ring): 00:00 at the top, clockwise. */
export const RING_SIZE = 260;
export const RING_CENTER = RING_SIZE / 2;
export const RING_RADIUS = 100;
export const RING_STROKE = 26;
export const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS; // ≈ 628.3
export const MINUTES_PER_DAY = 1440;

export interface RingArc {
  status: HalfHourSlotStatus;
  startMinutes: number;
  endMinutes: number;
  /** stroke-dasharray first value: arc length in SVG units */
  length: number;
  /** stroke-dashoffset (negative: shifts the dash clockwise from 12 o'clock) */
  offset: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Merges the 48 half-hour slots into contiguous same-status runs and converts them into SVG arcs. */
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
        length: round2(((endMinutes - startMinutes) / MINUTES_PER_DAY) * RING_CIRCUMFERENCE),
        offset: -round2((startMinutes / MINUTES_PER_DAY) * RING_CIRCUMFERENCE),
      });
      runStart = i;
    }
  }
  return arcs;
}

/** Position of the «now» marker on the ring (viewBox coordinates). */
export function ringMarkerPosition(nowMinutes: number): { x: number; y: number } {
  const clamped = Math.max(0, Math.min(MINUTES_PER_DAY, nowMinutes));
  const angle = (clamped / MINUTES_PER_DAY) * 2 * Math.PI;
  return {
    x: round2(RING_CENTER + RING_RADIUS * Math.sin(angle)),
    y: round2(RING_CENTER - RING_RADIUS * Math.cos(angle)),
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
