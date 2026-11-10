import React, { useId } from 'react';
import { HalfHourSlotStatus } from '../services/scheduleNormalizer';
import {
  RING_CENTER,
  RING_RADIUS_INNER,
  RING_RADIUS_OUTER,
  RING_SIZE,
  RING_STROKE,
  buildLapArcs,
  buildRingArcs,
  buildRingAriaLabel,
  dialPosition,
  polar,
  ringMarkerPosition,
  ringRadius,
} from '../services/ringGeometry';

interface DayRingProps {
  /** 48 half-hour slots; omit for the placeholder (dashed) rings */
  slots?: HalfHourSlotStatus[];
  /** Minutes since midnight for the «now» hand; null hides it (e.g. tomorrow) */
  nowMinutes: number | null;
  /** Override for the screen-reader label (placeholder ring) */
  ariaLabel?: string;
  /** Content shown in the centre of the dial */
  children?: React.ReactNode;
}

const TICK_INNER = 136; // ticks sit just outside the outer ring (outer edge = 132)
const TICK_OUTER = 140;
const TICK_OUTER_MAJOR = 144;
const LABEL_RADIUS = 153;

const HOUR_LABELS = [
  { text: '12', hour: 0 },
  { text: '3', hour: 3 },
  { text: '6', hour: 6 },
  { text: '9', hour: 9 },
];

export const DayRing: React.FC<DayRingProps> = ({ slots, nowMinutes, ariaLabel, children }) => {
  const rawId = useId();
  const hatchId = `maybe-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const arcs = slots ? buildLapArcs(slots) : [];
  const hasMaybe = arcs.some((a) => a.status === 'maybe');
  const marker = nowMinutes === null ? null : ringMarkerPosition(nowMinutes);
  const handFraction = nowMinutes === null ? 0 : dialPosition(nowMinutes).fraction;
  const label = ariaLabel ?? buildRingAriaLabel(slots ? buildRingArcs(slots) : []);

  return (
    <div className="day-ring">
      <svg
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        role="img"
        aria-label={label}
      >
        {hasMaybe && (
          <defs>
            <pattern
              id={hatchId}
              width="8"
              height="8"
              patternUnits="userSpaceOnUse"
              patternTransform="rotate(45)"
            >
              <rect width="8" height="8" className="ring-fill-on" />
              <rect width="4" height="8" className="ring-fill-off" />
            </pattern>
          </defs>
        )}

        {slots ? (
          <g transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`} fill="none" strokeWidth={RING_STROKE}>
            {arcs.map((arc) => (
              <circle
                key={`${arc.lap}-${arc.startMinutes}-${arc.status}`}
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={ringRadius(arc.lap)}
                className={`ring-arc ring-arc-${arc.status}`}
                style={arc.status === 'maybe' ? { stroke: `url(#${hatchId})` } : undefined}
                strokeDasharray={`${arc.length} ${arc.circumference.toFixed(1)}`}
                strokeDashoffset={arc.offset}
              />
            ))}
          </g>
        ) : (
          [RING_RADIUS_INNER, RING_RADIUS_OUTER].map((r) => (
            <circle
              key={r}
              cx={RING_CENTER}
              cy={RING_CENTER}
              r={r}
              fill="none"
              className="ring-empty"
              strokeWidth={RING_STROKE}
              strokeDasharray="3 9"
            />
          ))
        )}

        <g aria-hidden="true">
          {Array.from({ length: 12 }, (_, h) => {
            const major = h % 3 === 0;
            const a = polar(TICK_INNER, h / 12);
            const b = polar(major ? TICK_OUTER_MAJOR : TICK_OUTER, h / 12);
            return (
              <line
                key={h}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={major ? 'ring-tick ring-tick-major' : 'ring-tick'}
              />
            );
          })}
          {HOUR_LABELS.map((l) => {
            const p = polar(LABEL_RADIUS, l.hour / 12);
            return (
              <text
                key={l.text}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={12}
                fontWeight={600}
                className="ring-hour-label"
              >
                {l.text}
              </text>
            );
          })}

          {slots && (
            <>
              <LapTag x={6} anchor="start" lap={0} text="00–12" />
              <LapTag x={RING_SIZE - 6} anchor="end" lap={1} text="12–24" />
            </>
          )}

          {marker && (
            <>
              {(() => {
                const a = polar(RING_RADIUS_INNER - RING_STROKE / 2 - 2, handFraction);
                const b = polar(RING_RADIUS_OUTER + RING_STROKE / 2 + 2, handFraction);
                return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ring-hand" />;
              })()}
              <circle cx={marker.x} cy={marker.y} r={8} className="ring-marker" strokeWidth={3} />
            </>
          )}
        </g>
      </svg>
      <div className="day-ring-center">{children}</div>
    </div>
  );
};

/** Corner legend explaining which ring is which half of the day: a mini two-ring glyph + hours. */
const LapTag: React.FC<{ x: number; anchor: 'start' | 'end'; lap: 0 | 1; text: string }> = ({
  x,
  anchor,
  lap,
  text,
}) => {
  const gx = anchor === 'start' ? x + 7 : x - 7;
  const tx = anchor === 'start' ? x + 20 : x - 20;
  return (
    <g>
      <circle cx={gx} cy={12} r={3} className={lap === 0 ? 'ring-glyph ring-glyph-active' : 'ring-glyph'} />
      <circle cx={gx} cy={12} r={6.5} fill="none" className={lap === 1 ? 'ring-glyph-ring ring-glyph-active' : 'ring-glyph-ring'} />
      <text x={tx} y={12} textAnchor={anchor} dominantBaseline="central" fontSize={12} fontWeight={600} className="ring-hour-label">
        {text}
      </text>
    </g>
  );
};
