import React, { useState } from 'react';
import {
  AlertCircle,
  CalendarClock,
  CheckCircle2,
  ChevronDown,
  LayoutGrid,
  Sparkles,
  ZapOff,
} from 'lucide-react';
import {
  DaySchedule,
  GroupSchedule,
  HalfHourSlotStatus,
} from '../services/scheduleNormalizer';

interface ScheduleViewProps {
  schedule: GroupSchedule | undefined;
  nowMinutes: number;
  currentTimeStr: string;
  intradayChangeNote?: string;
}

function formatShortDate(dateKey: string): string {
  if (!dateKey) return '';
  const parts = dateKey.split('-');
  if (parts.length !== 3) return dateKey;
  return `${parts[2]}.${parts[1]}`;
}

function getDayNameShort(dateKey: string): string {
  if (!dateKey) return '';
  const [y, m, d] = dateKey.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const days = ['Нд', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
  return days[dt.getDay()] || '';
}

export const ScheduleView: React.FC<ScheduleViewProps> = ({
  schedule,
  nowMinutes,
  currentTimeStr,
  intradayChangeNote,
}) => {
  const [selectedDay, setSelectedDay] = useState<'today' | 'tomorrow'>('today');
  const [isHourlyGridOpen, setIsHourlyGridOpen] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('svitlo_hourly_grid_open');
      if (saved !== null) return saved === 'true';
    } catch {}
    return false; // Collapsed by default so intervals are visible immediately without scrolling
  });

  const toggleHourlyGrid = () => {
    setIsHourlyGridOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('svitlo_hourly_grid_open', String(next));
      } catch {}
      return next;
    });
  };

  if (!schedule) {
    return (
      <div className="schedule-panel">
        <div className="waiting-schedule-box">
          <CalendarClock size={26} />
          <div>Завантажуємо актуальний графік ДТЕК…</div>
        </div>
      </div>
    );
  }

  const activeDay: DaySchedule =
    selectedDay === 'today' ? schedule.today : schedule.tomorrow;
  const isToday = selectedDay === 'today';
  const currentHour = Math.floor(nowMinutes / 60);
  const nowPercent = Math.max(0, Math.min(100, (nowMinutes / 1440) * 100));

  // Build 24 hourly tiles from the 48 half-hour slots (Kyiv Digital 4x6 grid)
  const hourlyTiles = Array.from({ length: 24 }, (_, hour) => {
    const firstHalf: HalfHourSlotStatus = activeDay.slots[hour * 2] || 'on';
    const secondHalf: HalfHourSlotStatus = activeDay.slots[hour * 2 + 1] || 'on';

    let tileType: 'full-on' | 'full-off' | 'split-off-on' | 'split-on-off' = 'full-on';
    if (firstHalf === 'off' && secondHalf === 'off') {
      tileType = 'full-off';
    } else if (firstHalf === 'off' && secondHalf === 'on') {
      tileType = 'split-off-on';
    } else if (firstHalf === 'on' && secondHalf === 'off') {
      tileType = 'split-on-off';
    }

    return {
      hour,
      hourStr: `${String(hour).padStart(2, '0')}:00`,
      tileType,
      firstHalf,
      secondHalf,
    };
  });

  // Calculate maximum contiguous intervals for "on" and "off"
  const onIntervals = activeDay.intervals.filter((i) => i.status === 'on');
  const offIntervals = activeDay.intervals.filter((i) => i.status === 'off');

  const maxOnDuration =
    onIntervals.length > 0
      ? Math.max(...onIntervals.map((i) => i.durationHours))
      : 0;
  const maxOffDuration =
    offIntervals.length > 0
      ? Math.max(...offIntervals.map((i) => i.durationHours))
      : 0;

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      {intradayChangeNote && (
        <div className="change-alert-banner">
          <Sparkles size={18} className="change-alert-icon" />
          <div className="change-alert-content">
            <div className="change-alert-title">
              Графік оновлено протягом дня
            </div>
            <div>{intradayChangeNote}</div>
          </div>
        </div>
      )}

      {/* Segmented Switcher: ONLY Сьогодні and Завтра with weekday pills */}
      <div className="day-tabs-bar">
        <button
          type="button"
          className={`day-tab-btn ${selectedDay === 'today' ? 'active' : ''}`}
          onClick={() => setSelectedDay('today')}
        >
          <span className="day-tab-pill">{getDayNameShort(schedule.today.dateKey)}</span>
          <span>Сьогодні</span>
          <span className="day-tab-date">
            {formatShortDate(schedule.today.dateKey)}
          </span>
        </button>

        <button
          type="button"
          className={`day-tab-btn ${selectedDay === 'tomorrow' ? 'active' : ''}`}
          onClick={() => setSelectedDay('tomorrow')}
        >
          <span className="day-tab-pill">{getDayNameShort(schedule.tomorrow.dateKey)}</span>
          <span>Завтра</span>
          <span className="day-tab-date">
            {formatShortDate(schedule.tomorrow.dateKey)}
          </span>
        </button>
      </div>

      <div className="schedule-panel">
        {activeDay.status === 'WaitingForSchedule' ? (
          <div className="waiting-schedule-box">
            <CalendarClock size={28} />
            <div style={{ fontWeight: 700, color: 'var(--text-primary)' }}>
              Графік на завтра ще не затверджено ДТЕК
            </div>
            <div style={{ fontSize: '12.5px', maxWidth: '320px' }}>
              Зазвичай ДТЕК публікує розклад на наступний день увечері, але може
              оновлювати його і протягом доби. Щойно графік з’явиться, вам
              надійде сповіщення.
            </div>
          </div>
        ) : (
          <>
            {activeDay.status === 'EmergencyShutdowns' && (
              <div
                className="change-alert-banner"
                style={{
                  background: 'var(--status-off-bg)',
                  borderColor: 'var(--status-off-border)',
                }}
              >
                <AlertCircle
                  size={18}
                  style={{ color: 'var(--status-off)', flexShrink: 0 }}
                />
                <div className="change-alert-content">
                  <div
                    className="change-alert-title"
                    style={{ color: 'var(--status-off)' }}
                  >
                    Введено екстрені відключення
                  </div>
                  <div>
                    За командою Укренерго діють екстрені відключення.
                    Погодинні графіки тимчасово не діють.
                  </div>
                </div>
              </div>
            )}

            {/* Summary Totals & Maximum Contiguous Durations */}
            <div className="summary-stats-row">
              <div className="stat-box">
                <div className="stat-main-row">
                  <span className="stat-label">
                    <span className="status-dot on" /> Зі світлом
                  </span>
                  <span className="stat-value on">{activeDay.totalOnHours} год</span>
                </div>
                <div className="stat-sub-row">
                  <span className="stat-sub-label">Макс. проміжок</span>
                  <span className="stat-sub-value on">{maxOnDuration} год</span>
                </div>
              </div>

              <div className="stat-box">
                <div className="stat-main-row">
                  <span className="stat-label">
                    <span className="status-dot off" /> Без світла
                  </span>
                  <span className="stat-value off">
                    {activeDay.totalOffHours} год
                  </span>
                </div>
                <div className="stat-sub-row">
                  <span className="stat-sub-label">Макс. проміжок</span>
                  <span className="stat-sub-value off">{maxOffDuration} год</span>
                </div>
              </div>
            </div>

            {/* 24-Hour (48 half-hour slots) Timeline Bar */}
            <div className="timeline-strip-container">
              <div className="timeline-strip-header">
                <span>Шкала доби (крок 30 хв)</span>
                {isToday && (
                  <span>
                    Зараз у Києві:{' '}
                    <strong className="kyiv-clock">{currentTimeStr}</strong>
                  </span>
                )}
              </div>

              <div className="timeline-strip-bar">
                {activeDay.slots.map((slot, idx) => (
                  <div
                    key={idx}
                    className={`timeline-slot ${slot} ${
                      idx % 2 === 1 ? 'hour-end' : ''
                    }`}
                  />
                ))}
                {isToday && (
                  <div
                    className="timeline-now-marker"
                    style={{ left: `${nowPercent}%` }}
                    title={`Зараз ${currentTimeStr}`}
                  />
                )}
              </div>

              <div className="timeline-ruler">
                <span>00:00</span>
                <span>06:00</span>
                <span>12:00</span>
                <span>18:00</span>
                <span>24:00</span>
              </div>
            </div>

            {/* Intervals List (Primary view) */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="section-overline">
                <span>Інтервали за розкладом</span>
                <span>Сповіщення за 30 хв</span>
              </div>

              <div className="intervals-list">
                {activeDay.intervals.map((item, idx) => {
                  const isActiveNow =
                    isToday &&
                    nowMinutes >= item.startMinutes &&
                    nowMinutes < item.endMinutes;

                  const isOff = item.status === 'off';

                  return (
                    <div
                      key={`${item.start}-${idx}`}
                      className={`interval-row ${
                        isOff ? 'status-off' : 'status-on'
                      } ${isActiveNow ? 'active-now' : ''}`}
                    >
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '8px',
                        }}
                      >
                        <span className="interval-time-range">
                          {item.start} – {item.end}
                        </span>
                        {isActiveNow && <span className="now-pill">Зараз</span>}
                      </div>

                      <div className="interval-meta">
                        <span
                          className={`interval-badge ${isOff ? 'off' : 'on'}`}
                        >
                          {isOff ? (
                            <>
                              <ZapOff size={14} /> Відключення
                            </>
                          ) : (
                            <>
                              <CheckCircle2 size={14} /> Світло є
                            </>
                          )}
                        </span>
                        <span className="interval-duration">
                          {item.durationHours} год
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Kyiv Digital 4-Column x 6-Row Tile Grid (Collapsible at bottom) */}
            <div className="collapsible-grid-card">
              <button
                type="button"
                className="collapsible-grid-header"
                onClick={toggleHourlyGrid}
                aria-expanded={isHourlyGridOpen}
              >
                <div className="collapsible-header-left">
                  <LayoutGrid size={16} className="collapsible-header-icon" />
                  <span className="collapsible-header-title">Погодинний графік</span>
                  <span className="collapsible-header-badge">24 години</span>
                </div>
                <div className="collapsible-header-right">
                  <span className="collapsible-header-hint">
                    {isHourlyGridOpen ? 'Згорнути' : 'Розгорнути'}
                  </span>
                  <ChevronDown
                    size={18}
                    className={`collapsible-header-chevron ${
                      isHourlyGridOpen ? 'open' : ''
                    }`}
                  />
                </div>
              </button>

              {isHourlyGridOpen && (
                <div className="collapsible-grid-body">
                  <div className="kyiv-hourly-grid">
                    {hourlyTiles.map((tile) => {
                      const isCurrent = isToday && tile.hour === currentHour;

                      if (tile.tileType === 'split-off-on' || tile.tileType === 'split-on-off') {
                        return (
                          <div
                            key={tile.hour}
                            className={`kyiv-hour-card split-tile ${tile.tileType} ${
                              isCurrent ? 'current-hour' : ''
                            }`}
                          >
                            <div className={`split-bg ${tile.tileType}`} />
                            <div className="split-text-layer left-layer">
                              <span>{tile.hourStr}</span>
                            </div>
                            <div className="split-text-layer right-layer">
                              <span>{tile.hourStr}</span>
                            </div>
                          </div>
                        );
                      }

                      const isOff = tile.tileType === 'full-off';

                      return (
                        <div
                          key={tile.hour}
                          className={`kyiv-hour-card ${
                            isOff ? 'tile-off' : 'tile-on'
                          } ${isCurrent ? 'current-hour' : ''}`}
                        >
                          {isOff ? (
                            <ZapOff size={16} className="tile-icon off" />
                          ) : (
                            <span className="tile-lightning-icon">⚡</span>
                          )}
                          <span className="tile-time-text">{tile.hourStr}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Kyiv Digital Signature Legend */}
                  <div className="kyiv-grid-legend">
                    <div className="legend-item">
                      <span className="legend-ring current" />
                      <span>поточний час</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-circle on" />
                      <span>є світло</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-circle off" />
                      <span>немає світла</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
};
