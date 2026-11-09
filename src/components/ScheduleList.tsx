import React from 'react';
import { TimeInterval } from '../services/scheduleNormalizer';

interface ScheduleListProps {
  intervals: TimeInterval[];
  /** minutes since midnight when the list is for today; null otherwise */
  nowMinutes: number | null;
}

const STATUS_LABEL: Record<TimeInterval['status'], string> = {
  on: 'є світло',
  off: 'немає',
  maybe: 'можливо немає',
};

export const ScheduleList: React.FC<ScheduleListProps> = ({ intervals, nowMinutes }) => {
  return (
    <ul className="schedule-list">
      {intervals.map((it) => {
        const isNow =
          nowMinutes !== null && nowMinutes >= it.startMinutes && nowMinutes < it.endMinutes;
        return (
          <li
            key={`${it.startMinutes}-${it.status}`}
            className={`schedule-row schedule-row-${it.status}${isNow ? ' is-now' : ''}`}
            aria-current={isNow ? 'time' : undefined}
          >
            <span>
              {it.start} – {it.end}
            </span>
            <span className="schedule-row-status">
              {isNow ? `зараз · ${STATUS_LABEL[it.status]}` : STATUS_LABEL[it.status]}
            </span>
          </li>
        );
      })}
    </ul>
  );
};
