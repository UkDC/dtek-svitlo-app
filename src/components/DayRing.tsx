import React, { useId } from 'react';
import { HalfHourSlotStatus } from '../services/scheduleNormalizer';
import {
  RING_CENTER,
  RING_CIRCUMFERENCE,
  RING_RADIUS,
  RING_SIZE,
  RING_STROKE,
  buildRingArcs,
  buildRingAriaLabel,
  ringMarkerPosition,
} from '../services/ringGeometry';

interface DayRingProps {
  /** 48 half-hour slots; omit for the placeholder (dashed) ring */
  slots?: HalfHourSlotStatus[];
  /** Minutes since midnight for the «now» marker; null hides it (e.g. tomorrow) */
  nowMinutes: number | null;
  /** Override for the screen-reader label (placeholder ring) */
  ariaLabel?: string;
  /** Content shown in the centre of the ring */
  children?: React.ReactNode;
}

const HOUR_LABELS: Array<{ text: string; x: number; y: number; anchor: 'start' | 'middle' | 'end' }> = [
  { text: '00', x: 130, y: 12, anchor: 'middle' },
  { text: '06', x: 249, y: 134, anchor: 'start' },
  { text: '12', x: 130, y: 255, anchor: 'middle' },
  { text: '18', x: 11, y: 134, anchor: 'end' },
];

export const DayRing: React.FC<DayRingProps> = ({ slots, nowMinutes, ariaLabel, children }) => {
  const rawId = useId();
  const hatchId = `maybe-${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const arcs = slots ? buildRingArcs(slots) : [];
  const hasMaybe = arcs.some((a) => a.status === 'maybe');
  const marker = nowMinutes === null ? null : ringMarkerPosition(nowMinutes);
  const label = ariaLabel ?? buildRingAriaLabel(arcs);

  return (
    <div className="day-ring">
      <svg
        width={RING_SIZE}
        height={RING_SIZE}
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
                key={`${arc.startMinutes}-${arc.status}`}
                cx={RING_CENTER}
                cy={RING_CENTER}
                r={RING_RADIUS}
                className={`ring-arc ring-arc-${arc.status}`}
                style={arc.status === 'maybe' ? { stroke: `url(#${hatchId})` } : undefined}
                strokeDasharray={`${arc.length} ${RING_CIRCUMFERENCE.toFixed(1)}`}
                strokeDashoffset={arc.offset}
              />
            ))}
          </g>
        ) : (
          <circle
            cx={RING_CENTER}
            cy={RING_CENTER}
            r={RING_RADIUS}
            fill="none"
            className="ring-empty"
            strokeWidth={RING_STROKE}
            strokeDasharray="6 10"
          />
        )}

        {marker && (
          <circle
            cx={marker.x}
            cy={marker.y}
            r={11}
            className="ring-marker"
            strokeWidth={3}
          />
        )}

        {slots &&
          HOUR_LABELS.map((l) => (
            <text
              key={l.text}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              fontSize={11}
              fontWeight={600}
              className="ring-hour-label"
              aria-hidden="true"
            >
              {l.text}
            </text>
          ))}
      </svg>
      <div className="day-ring-center">{children}</div>
    </div>
  );
};
