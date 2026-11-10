import React, { useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  DaySchedule,
  GroupSchedule,
  formatDurationHours,
  getCurrentAddressStatus,
} from '../services/scheduleNormalizer';
import { DayRing } from './DayRing';
import { ScheduleList } from './ScheduleList';

interface DayOverviewProps {
  schedule: GroupSchedule | undefined;
  nowMinutes: number;
  currentTimeStr: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}

type DayKey = 'today' | 'tomorrow';

const WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];

const hoursText = (h: number) => formatDurationHours(h).replace('.', ',');

function dayLabel(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  if (!y || !m || !d) return '';
  const weekday = WEEKDAYS[new Date(y, m - 1, d).getDay()];
  return `${weekday}, ${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}`;
}

function sumHours(day: DaySchedule, status: 'on' | 'off' | 'maybe'): number {
  return day.slots.filter((s) => s === status).length / 2;
}

export const DayOverview: React.FC<DayOverviewProps> = ({
  schedule,
  nowMinutes,
  currentTimeStr,
  isRefreshing,
  onRefresh,
}) => {
  const [selectedDay, setSelectedDay] = useState<DayKey>('today');
  const isToday = selectedDay === 'today';
  const day: DaySchedule | undefined = schedule
    ? isToday
      ? schedule.today
      : schedule.tomorrow
    : undefined;
  const status = getCurrentAddressStatus(schedule, nowMinutes);

  const hasData = day?.status === 'ScheduleApplies';
  const onHours = hasData ? sumHours(day, 'on') : 0;

  const renderCenter = () => {
    if (!schedule || !day) {
      return <span className="ring-center-note">Завантажуємо графік…</span>;
    }
    if (!isToday) {
      if (day.status === 'WaitingForSchedule') {
        return <span className="ring-center-note">Графік на завтра ще не опубліковано</span>;
      }
      if (day.status === 'EmergencyShutdowns') {
        return <span className="ring-center-title ring-center-title-small">Екстрені відключення</span>;
      }
      return (
        <>
          <span className="ring-center-time">{dayLabel(day.dateKey)}</span>
          <span className="ring-center-title">Завтра</span>
          <span className="ring-center-target">зі світлом {hoursText(onHours)}</span>
        </>
      );
    }
    if (status.state === 'emergency') {
      return <span className="ring-center-title ring-center-title-small">Екстрені відключення</span>;
    }
    if (status.state === 'waiting') {
      return <span className="ring-center-note">Графік ще не опубліковано</span>;
    }
    const isOn = status.state === 'on';
    // «(завтра)» only where «до 05:00» could be read as today (target clock time still ahead)
    const targetMin = status.targetTime
      ? Number(status.targetTime.slice(0, 2)) * 60 + Number(status.targetTime.slice(3, 5))
      : 0;
    const needsTomorrow = status.targetIsTomorrow && targetMin >= nowMinutes;
    const tail = status.targetTime
      ? `до ${status.targetTime}${needsTomorrow ? ' (завтра)' : ''}`
      : 'більше без відключень';
    return (
      <>
        <span className="ring-center-time">{currentTimeStr}</span>
        <span className="ring-center-title">
          {isOn ? (
            <>
              Світло
              <br />є
            </>
          ) : (
            <>
              Світла
              <br />
              немає
            </>
          )}
        </span>
        <span className="ring-center-target">{tail}</span>
      </>
    );
  };

  return (
    <section className="day-overview">
      <DayRing
        slots={hasData ? day.slots : undefined}
        nextDaySlots={
          isToday && schedule?.tomorrow.status === 'ScheduleApplies' ? schedule.tomorrow.slots : undefined
        }
        nowMinutes={hasData && isToday ? nowMinutes : null}
        ariaLabel={
          !schedule
            ? 'Графік завантажується'
            : hasData
            ? undefined
            : day?.status === 'EmergencyShutdowns'
            ? 'Діють екстрені відключення'
            : 'Графік ще не опубліковано'
        }
      >
        {renderCenter()}
      </DayRing>

      <div className="day-tabs" role="tablist" aria-label="День">
        <button
          type="button"
          role="tab"
          aria-selected={isToday}
          className={`day-tab${isToday ? ' is-active' : ''}`}
          onClick={() => setSelectedDay('today')}
        >
          Сьогодні
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!isToday}
          className={`day-tab${!isToday ? ' is-active' : ''}`}
          onClick={() => setSelectedDay('tomorrow')}
        >
          Завтра
        </button>
      </div>

      {hasData ? (
        <ScheduleList intervals={day.intervals} nowMinutes={isToday ? nowMinutes : null} />
      ) : (
        schedule && (
          <p className="schedule-empty">
            {day?.status === 'EmergencyShutdowns'
              ? schedule.emergencyNote ||
                'Діють екстрені відключення поза графіком. Погодинні графіки тимчасово не діють.'
              : isToday
              ? 'ДТЕК ще не опублікував графік на сьогодні.'
              : 'Зазвичай ДТЕК публікує графік на наступний день увечері.'}
          </p>
        )
      )}

      {schedule && (
        <button
          type="button"
          className="updated-line"
          onClick={onRefresh}
          disabled={isRefreshing}
          aria-label="Оновити графік"
        >
          <RefreshCw size={14} className={isRefreshing ? 'spin' : ''} aria-hidden="true" />
          <span>{isRefreshing ? 'Оновлюємо…' : `Дані ДТЕК від ${schedule.updatedAt}`}</span>
        </button>
      )}
    </section>
  );
};
