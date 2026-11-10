import React, { useId } from 'react';
import { HalfHourSlotStatus } from '../services/scheduleNormalizer';
import {
  DialRing,
  RING_CENTER,
  RING_PAD,
  RING_RADIUS_INNER,
  RING_RADIUS_INNER_LABEL,
  RING_RADIUS_OUTER,
  RING_RADIUS_OUTER_LABEL,
  RING_SIZE,
  RING_STROKE_EVEN,
  RING_STROKE_IDLE,
  buildRingArcs,
  buildRingAriaLabel,
  planDial,
  polar,
} from '../services/ringGeometry';

interface DayRingProps {
  /** 48 half-hour slots of the shown day; omit for the placeholder (dashed) rings */
  slots?: HalfHourSlotStatus[];
  /** Tomorrow's slots: lets the current interval continue past 24:00 on the inner ring */
  nextDaySlots?: HalfHourSlotStatus[];
  /** Minutes since midnight for the «now» hand; null hides it (e.g. tomorrow) */
  nowMinutes: number | null;
  /** Override for the screen-reader label (placeholder ring) */
  ariaLabel?: string;
  /** Content shown in the centre of the dial */
  children?: React.ReactNode;
}

const TICK_START = 80; // ticks sit just inside the inner ring (its inner edge is ≥ 85)
const TICK_END = 77;
const TICK_END_MAJOR = 73;
// The hand starts inside the inner ring for the morning, between the rings for the evening
const HAND_FROM_INNER = 72;
const HAND_FROM_OUTER = 108;
const HAND_PAST_RING = 18;

export const DayRing: React.FC<DayRingProps> = ({ slots, nextDaySlots, nowMinutes, ariaLabel, children }) => {
  const rawId = useId();
  const hatchId = `maybe-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const plan = slots ? planDial({ slots, nowMinutes, nextDaySlots }) : null;
  const hasMaybe = !!plan && [...plan.inner.arcs, ...plan.outer.arcs].some((a) => a.status === 'maybe');
  const label = ariaLabel ?? buildRingAriaLabel(slots ? buildRingArcs(slots) : []);
  // A ring is «quiet» when another half is active: thin arcs and dimmed digits
  const quiet = (ring: DialRing) => plan?.activeHalf != null && !ring.active;

  const renderRing = (ring: DialRing) => (
    <g
      transform={`rotate(-90 ${RING_CENTER} ${RING_CENTER})`}
      fill="none"
      strokeWidth={ring.strokeWidth}
      className={ring.active ? 'ring-active' : 'ring-idle'}
    >
      {/* Empty track: shows where already finished intervals were, without any data */}
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={ring.radius}
        className="ring-base"
        strokeDasharray={`${ring.base.length} ${ring.base.circumference.toFixed(1)}`}
        strokeDashoffset={ring.base.offset}
      />
      {ring.arcs.map((arc) => (
        <circle
          key={`${arc.nextDay ? 'n' : 't'}-${arc.startMinutes}-${arc.status}-${arc.past ? 'p' : 'f'}`}
          cx={RING_CENTER}
          cy={RING_CENTER}
          r={ring.radius}
          className={`ring-arc ring-arc-${arc.status}${arc.past ? ' ring-arc-past' : ''}`}
          style={arc.status === 'maybe' ? { stroke: `url(#${hatchId})` } : undefined}
          strokeDasharray={`${arc.length} ${arc.circumference.toFixed(1)}`}
          strokeDashoffset={arc.offset}
        />
      ))}
    </g>
  );

  // «No data» placeholders: two plain faint rings, deliberately unlike the coloured arcs
  const emptyRings = (
    <>
      <circle cx={RING_CENTER} cy={RING_CENTER} r={RING_RADIUS_INNER} fill="none" className="ring-empty ring-empty-main" strokeWidth={RING_STROKE_EVEN} />
      <circle
        cx={RING_CENTER}
        cy={RING_CENTER}
        r={RING_RADIUS_OUTER}
        fill="none"
        className="ring-empty"
        strokeWidth={RING_STROKE_IDLE / 4}
        strokeLinecap="round"
        strokeDasharray="0.1 7"
      />
    </>
  );

  const renderDigits = (labels: { text: string; fraction: number }[], radius: number, dim: boolean, keyPrefix: string) =>
    labels.map((l) => {
      const p = polar(radius, l.fraction);
      return (
        <text
          key={`${keyPrefix}-${l.text}`}
          x={p.x}
          y={p.y}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={13}
          fontWeight={dim ? 600 : 700}
          className={dim ? 'ring-hour-label ring-hour-label-dim' : 'ring-hour-label'}
        >
          {l.text}
        </text>
      );
    });

  const activeRadius = plan?.activeHalf === 1 ? RING_RADIUS_OUTER : RING_RADIUS_INNER;
  const handFrom = plan?.activeHalf === 1 ? HAND_FROM_OUTER : HAND_FROM_INNER;

  return (
    <div className="day-ring">
      <svg
        viewBox={`${-RING_PAD} ${-RING_PAD} ${RING_SIZE + 2 * RING_PAD} ${RING_SIZE + 2 * RING_PAD}`}
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

        {plan ? (
          <>
            {renderRing(plan.inner)}
            {renderRing(plan.outer)}
          </>
        ) : (
          emptyRings
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
          {/* Digits are fixed: 00–09 always inside, 12–21 always outside */}
          {plan && renderDigits(plan.inner.hourLabels, RING_RADIUS_INNER_LABEL, quiet(plan.inner), 'in')}
          {plan && renderDigits(plan.outer.hourLabels, RING_RADIUS_OUTER_LABEL, quiet(plan.outer), 'out')}

          {plan && plan.nowFraction !== null && (
            <>
              {(() => {
                const a = polar(handFrom, plan.nowFraction);
                const b = polar(activeRadius + HAND_PAST_RING, plan.nowFraction);
                return <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} className="ring-hand" />;
              })()}
              {(() => {
                const m = polar(activeRadius, plan.nowFraction);
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
