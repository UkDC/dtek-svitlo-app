import React, { useState } from 'react';
import { Bell, RefreshCw, Sparkles } from 'lucide-react';
import {
  DaySchedule,
  GroupSchedule,
  formatDurationHours,
  formatMinutesToTime,
  getCurrentAddressStatus,
} from '../services/scheduleNormalizer';
import { DayRing } from './DayRing';
import { ScheduleList } from './ScheduleList';

interface DayOverviewProps {
  schedule: GroupSchedule | undefined;
  nowMinutes: number;
  currentTimeStr: string;
  /** In-app reminder («за 30 хв») is active for this address */
  remindersOn: boolean;
  intradayChangeNote?: string;
  isRefreshing: boolean;
  onRefresh: () => void;
}

type DayKey = 'today' | 'tomorrow';

const WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'];
const REMINDER_LEAD_MIN = 30;

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
  remindersOn,
  intradayChangeNote,
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
  const offHours = hasData ? sumHours(day, 'off') : 0;
  const maybeHours = hasData ? sumHours(day, 'maybe') : 0;

  // Reminder shown only while light is on and the reminder moment is still ahead
  let reminderTime: string | null = null;
  if (
    isToday &&
    remindersOn &&
    status.state === 'on' &&
    status.nextOutage
  ) {
    const outageAbs = (status.nextOutageIsTomorrow ? 1440 : 0) + status.nextOutage.startMinutes;
    const remindAbs = outageAbs - REMINDER_LEAD_MIN;
    if (remindAbs > nowMinutes) {
      reminderTime = `${remindAbs >= 1440 ? 'завтра о ' : ''}${formatMinutesToTime(remindAbs % 1440)}`;
    }
  }

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

      {hasData && (
        <div className="ring-legend">
          <span className="legend-item">
            <span className="legend-dot legend-dot-on" />
            зі світлом {hoursText(onHours)}
          </span>
          <span className="legend-item">
            <span className="legend-dot legend-dot-off" />
            без світла {hoursText(offHours)}
          </span>
          {maybeHours > 0 && (
            <span className="legend-item">
              <span className="legend-dot legend-dot-maybe" />
              можливо {hoursText(maybeHours)}
            </span>
          )}
        </div>
      )}

      {intradayChangeNote && (
        <div className="note-banner" role="status">
          <Sparkles size={18} aria-hidden="true" />
          <span>
            <b>Графік оновлено протягом дня.</b> {intradayChangeNote}
          </span>
        </div>
      )}

      {reminderTime && (
        <div className="note-banner note-banner-reminder">
          <Bell size={18} aria-hidden="true" />
          <span>
            Нагадаємо близько <b>{reminderTime}</b>, за {REMINDER_LEAD_MIN} хв до відключення
          </span>
        </div>
      )}

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
