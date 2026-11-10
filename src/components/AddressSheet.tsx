import React, { useEffect, useRef } from 'react';
import { Check, Pencil, Plus } from 'lucide-react';
import {
  GroupSchedule,
  SavedAddress,
  getCurrentAddressStatus,
} from '../services/scheduleNormalizer';

interface AddressSheetProps {
  addresses: SavedAddress[];
  selectedId: string;
  schedulesByAddressId: Record<string, GroupSchedule | undefined>;
  nowMinutes: number;
  onSelect: (id: string) => void;
  onEdit: (address: SavedAddress) => void;
  onAdd: () => void;
  onClose: () => void;
}

export const regionName = (a: SavedAddress) => (a.region === 'krem' ? 'Київська обл.' : 'Київ');

export function addressTitle(a: SavedAddress): string {
  return a.label?.trim() || [a.street, a.house].filter(Boolean).join(', ') || 'Адреса';
}

function liveStatusText(schedule: GroupSchedule | undefined, nowMinutes: number) {
  const s = getCurrentAddressStatus(schedule, nowMinutes);
  switch (s.state) {
    case 'on':
      return { dot: 'on', text: s.targetTime ? `зараз є світло до ${s.targetTime}` : 'зараз є світло' };
    case 'off':
      return { dot: 'off', text: `зараз без світла до ${s.targetTime ?? ''}`.trim() };
    case 'emergency':
      return { dot: 'off', text: 'екстрені відключення' };
    default:
      return { dot: 'none', text: 'графік очікується' };
  }
}

export const AddressSheet: React.FC<AddressSheetProps> = ({
  addresses,
  selectedId,
  schedulesByAddressId,
  nowMinutes,
  onSelect,
  onEdit,
  onAdd,
  onClose,
}) => {
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="address-sheet-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sheet-grabber" aria-hidden="true" />
        <h2 id="address-sheet-title" className="sheet-title" tabIndex={-1} ref={titleRef}>
          Мої адреси
        </h2>

        <div className="sheet-list">
          {addresses.map((addr) => {
            const live = liveStatusText(schedulesByAddressId[addr.id], nowMinutes);
            const isActive = addr.id === selectedId;
            return (
              <div key={addr.id} className="sheet-row-wrap">
                <button
                  type="button"
                  className={`sheet-row${isActive ? ' is-active' : ''}`}
                  aria-current={isActive ? 'true' : undefined}
                  onClick={() => onSelect(addr.id)}
                >
                  <span className={`sheet-dot sheet-dot-${live.dot}`} aria-hidden="true" />
                  <span className="sheet-row-text">
                    <span className="sheet-row-name">{addressTitle(addr)}</span>
                    <span className="sheet-row-meta">
                      {regionName(addr)} · Група {addr.group} · {live.text}
                    </span>
                  </span>
                  {isActive && <Check size={20} strokeWidth={2.6} aria-hidden="true" />}
                </button>
                <button
                  type="button"
                  className="sheet-edit"
                  aria-label={`Змінити адресу «${addressTitle(addr)}»`}
                  onClick={() => onEdit(addr)}
                >
                  <Pencil size={16} aria-hidden="true" />
                </button>
              </div>
            );
          })}
        </div>

        <button type="button" className="sheet-add" onClick={onAdd}>
          <Plus size={18} strokeWidth={2.4} aria-hidden="true" />
          Додати адресу
        </button>
      </div>
    </div>
  );
};
