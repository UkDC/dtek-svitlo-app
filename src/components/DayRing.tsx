import React, { useId } from 'react';
import { HalfHourSlotStatus } from '../services/scheduleNormalizer';
import {
  DialArc,
  RING_CENTER,
  RING_RADIUS_MAIN,
  RING_RADIUS_TRACK,
  RING_SIZE,
  RING_STROKE_MAIN,
  RING_STROKE_TRACK,
  buildHourLabels,
  buildRingArcs,
  buildRingAriaLabel,
  planDial,
  polar,
} from '../services/ringGeometry';

interface DayRingProps {
  /** 48 half-hour slots of the shown day; omit for the placeholder (dashed) rings */
  slots?: HalfHourSlotStatus[];
  /** 48 slots of the following day: feeds the thin outer track after 12:00. Omit → dashed track */
  nextDaySlots?: HalfHourSlotStatus[];
  /** Minutes since midnight for the «now» hand; null hides it (e.g. tomorrow) */
  nowMinutes: number | null;
  /** Override for the screen-reader label (placeholder ring) */
  ariaLabel?: string;
  /** Content shown in the centre of the dial */
  children?: React.ReactNode;
}

const TICK_START = 87; // ticks sit just inside the main ring (inner edge = 91)
const TICK_END = 84;
const TICK_END_MAJOR = 80;
const DIGIT_RADIUS = 68;
const HAND_FROM = 82;
const HAND_TO = 126;

export const DayRing: React.FC<DayRingProps> = ({ slots, nextDaySlots, nowMinutes, ariaLabel, children }) => {
  const rawId = useId();
  const hatchId = `maybe-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const plan = slots ? planDial({ slots, nowMinutes, nextDaySlots }) : null;
  const hasMaybe = !!plan && (plan.main.some((a) => a.status === 'maybe') || !!plan.track?.some((a) => a.status === 'maybe'));
  const label = ariaLabel ?? buildRingAriaLabel(slots ? buildRingArcs(slots) : []);
  const hourLabels = plan ? plan.hourLabels : buildHourLabels(0);

  const renderArcs = (arcs: DialArc[], radius: number, strokeWidth: number, className: string) => (
    <g transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`} fill="none" strokeWidth={strokeWidth}>
      {arcs.map((arc) => (
        <circle
          key={`${arc.startMinutes}-${arc.status}-${arc.past ? 'p' : 'f'}`}
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={radius}
          className={`${className} ring-arc-${arc.status}${arc.past ? ' ring-arc-past' : ''}`}
          style={arc.status === 'maybe' ? { stroke: `url(#${hatchId})` } : undefined}
          strokeDasharray={`${arc.length} ${arc.circumference.toFixed(1)}`}
          strokeDashoffset={arc.offset}
        />
      ))}
    </g>
  );

  const dashedRing = (radius: number, strokeWidth: number, dash: string) => (
    <circle
      cx={RING_CENTER}
      cy={RING_CENTER}
      r={radius}
      fill="none"
      className="ring-empty"
      strokeWidth={strokeWidth}
      strokeDasharray={dash}
    />
  );

  return (
    <div className="day-ring">
      <svg viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`} role="img" aria-label={label}>
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

        {plan ? (
          <>
            {plan.track
              ? renderArcs(plan.track, RING_RADIUS_TRACK, RING_STROKE_TRACK, 'ring-arc ring-track')
              : dashedRing(RING_RADIUS_TRACK, RING_STROKE_TRACK, '3 6')}
            {renderArcs(plan.main, RING_RADIUS_MAIN, RING_STROKE_MAIN, 'ring-arc')}
          </>
        ) : (
          <>
            {dashedRing(RING_RADIUS_TRACK, RING_STROKE_TRACK, '3 6')}
            {dashedRing(RING_RADIUS_MAIN, RING_STROKE_MAIN, '3 9')}
          </>
        )}

        <g aria-hidden="true">
          {Array.from({ length: 12 }, (_, k) => {
            const major = k % 3 === 0;
            const a = polar(TICK_START, k / 12);
            const b = polar(major ? TICK_END_MAJOR : TICK_END, k / 12);
            return (
              <line
                key={k}
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={major ? 'ring-tick ring-tick-major' : 'ring-tick'}
              />
            );
          })}
          {hourLabels.map((l) => {
            const p = polar(DIGIT_RADIUS, l.fraction);
            return (
              <text
                key={l.text}
                x={p.x}
                y={p.y}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={10.5}
                fontWeight={600}
                className="ring-hour-label"
              >
                {l.text}
              </text>
            );
          })}

          {plan && plan.nowFraction !== null && (
            <>
              {(() => {
                const a = polar(HAND_FROM, plan.nowFraction);
                const b = polar(HAND_TO, plan.nowFraction);
                return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ring-hand" />;
              })()}
              {(() => {
                const m = polar(RING_RADIUS_MAIN, plan.nowFraction);
                return <circle cx={m.x} cy={m.y} r={8} className="ring-marker" strokeWidth={3} />;
              })()}
            </>
          )}
        </g>
      </svg>
      <div className="day-ring-center">{children}</div>
    </div>
  );
};
