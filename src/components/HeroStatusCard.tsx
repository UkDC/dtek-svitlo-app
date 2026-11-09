import React from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Pencil,
  RefreshCw,
  Zap,
  ZapOff,
} from 'lucide-react';
import {
  GroupSchedule,
  SavedAddress,
  getCurrentAddressStatus,
} from '../services/scheduleNormalizer';
import { getRegionShortTitle } from '../services/addressCatalog';

interface HeroStatusCardProps {
  address: SavedAddress;
  schedule: GroupSchedule | undefined;
  nowMinutes: number;
  isRefreshing: boolean;
  onRefresh: () => void;
  onEditAddress: (address: SavedAddress) => void;
}

function getComplexSchemeLabel(address: SavedAddress): string | null {
  const h = address.house.toLowerCase();
  if (h.includes('лінія 2') || h.includes('ввод 2')) {
    return 'Складна схема підключення • лінія 2';
  }
  if (h.includes('лінія 1') || h.includes('ввод 1')) {
    return 'Складна схема підключення • лінія 1';
  }
  return null;
}

function getCleanAddressDisplay(address: SavedAddress): string {
  const cleanHouse = address.house
    .replace(/\s*\([^)]*\)\s*/g, '')
    .replace(/\s*(лінія|ввод)\s*\d+/gi, '')
    .trim();
  if (!cleanHouse) return address.street;
  return `${address.street}, ${cleanHouse}`;
}

export const HeroStatusCard: React.FC<HeroStatusCardProps> = ({
  address,
  schedule,
  nowMinutes,
  isRefreshing,
  onRefresh,
  onEditAddress,
}) => {
  const summary = getCurrentAddressStatus(schedule, nowMinutes);

  const cardStateClass =
    summary.state === 'off'
      ? 'state-off'
      : summary.state === 'emergency'
      ? 'state-emergency'
      : summary.state === 'waiting'
      ? 'state-waiting'
      : 'state-on';

  const orbClass =
    summary.state === 'off'
      ? 'off'
      : summary.state === 'emergency'
      ? 'emergency'
      : summary.state === 'waiting'
      ? 'waiting'
      : 'on';

  const complexScheme = getComplexSchemeLabel(address);
  const cleanAddressTitle = getCleanAddressDisplay(address);

  const fullAddressLine = [
    address.region === 'krem' ? address.city : 'м. Київ',
    cleanAddressTitle,
  ]
    .filter(Boolean)
    .join(' • ');

  return (
    <section className={`hero-card ${cardStateClass}`}>
      <div className="hero-top-row">
        <div className="hero-address-badge">
          {complexScheme ? (
            <div className="hero-complex-scheme">{complexScheme}</div>
          ) : (
            <div className="hero-address-subtitle">
              {fullAddressLine} • {getRegionShortTitle(address.region)}
            </div>
          )}

          <div className="hero-address-title">
            <span>{address.icon || '🏠'}</span>
            <span className="hero-address-main-text">
              {address.label && address.label !== cleanAddressTitle
                ? `${address.label} (${cleanAddressTitle})`
                : cleanAddressTitle}
            </span>
            <button
              type="button"
              className="address-pill-edit"
              title="Перейменувати або змінити адресу"
              onClick={() => onEditAddress(address)}
            >
              <Pencil size={12} />
            </button>
          </div>
        </div>

        <span className="group-chip">Група {address.group}</span>
      </div>

      {/* Kyiv Digital Signature Status Pill Badge */}
      <div className="kyiv-hero-badge-wrap">
        <div className={`kyiv-hero-badge ${orbClass}`}>
          {summary.state === 'off' ? (
            <ZapOff size={15} />
          ) : summary.state === 'emergency' ? (
            <AlertTriangle size={15} />
          ) : summary.state === 'waiting' ? (
            <Clock size={15} />
          ) : (
            <Zap size={15} fill="currentColor" />
          )}
          <span>{summary.badgeText}</span>
        </div>
      </div>

      <div className="hero-status-main">
        <div className={`hero-status-orb ${orbClass}`}>
          {summary.state === 'off' ? (
            <ZapOff size={22} />
          ) : summary.state === 'emergency' ? (
            <AlertTriangle size={22} />
          ) : summary.state === 'waiting' ? (
            <Clock size={22} />
          ) : (
            <CheckCircle2 size={22} />
          )}
        </div>

        <div className="hero-status-text">
          <div className={`hero-headline ${orbClass}`}>{summary.headline}</div>
          <div className="hero-subline">{summary.subline}</div>
        </div>
      </div>

      <div className="hero-footer-row">
        <span>
          Актуальність ДТЕК:{' '}
          <strong style={{ color: 'var(--text-primary)' }}>
            {schedule?.updatedAt || 'Завантаження…'}
          </strong>
        </span>

        <button
          type="button"
          className="refresh-inline-btn"
          onClick={onRefresh}
          disabled={isRefreshing}
        >
          <RefreshCw size={12} className={isRefreshing ? 'spin' : ''} />
          <span>{isRefreshing ? 'Оновлення…' : 'Оновити'}</span>
        </button>
      </div>
    </section>
  );
};
