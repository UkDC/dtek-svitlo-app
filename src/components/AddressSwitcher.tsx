import React from 'react';
import { Pencil, Plus } from 'lucide-react';
import {
  GroupSchedule,
  SavedAddress,
  getCurrentAddressStatus,
} from '../services/scheduleNormalizer';
import { getRegionShortTitle } from '../services/addressCatalog';

interface AddressSwitcherProps {
  addresses: SavedAddress[];
  selectedId: string;
  schedulesByAddressId: Record<string, GroupSchedule | undefined>;
  nowMinutes: number;
  onSelect: (id: string) => void;
  onEdit: (address: SavedAddress) => void;
  onAdd: () => void;
}

export const AddressSwitcher: React.FC<AddressSwitcherProps> = ({
  addresses,
  selectedId,
  schedulesByAddressId,
  nowMinutes,
  onSelect,
  onEdit,
  onAdd,
}) => {
  return (
    <section className="address-switcher-wrap">
      <div className="section-overline">
        <span>Мои адреса ({addresses.length})</span>
        <button
          type="button"
          onClick={onAdd}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent-primary)',
            fontWeight: 700,
            fontSize: '11.5px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
            gap: '4px',
          }}
        >
          <Plus size={13} /> Добавить
        </button>
      </div>

      <div className="address-pills-scroll">
        {addresses.map((addr) => {
          const sched = schedulesByAddressId[addr.id];
          const status = getCurrentAddressStatus(sched, nowMinutes);
          const isSelected = addr.id === selectedId;
          const dotClass =
            status.state === 'off'
              ? 'off'
              : status.state === 'emergency'
              ? 'emergency'
              : status.state === 'waiting'
              ? 'waiting'
              : 'on';

          const addressDesc = [addr.street, addr.house]
            .filter(Boolean)
            .join(', ');

          return (
            <div
              key={addr.id}
              role="button"
              tabIndex={0}
              className={`address-pill ${isSelected ? 'active' : ''}`}
              onClick={() => onSelect(addr.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') onSelect(addr.id);
              }}
            >
              <span className="address-pill-emoji">{addr.icon || '🏠'}</span>
              <div className="address-pill-info">
                <div className="address-pill-name-row">
                  <span className={`status-dot ${dotClass}`} />
                  <span className="address-pill-name">{addr.label}</span>
                </div>
                <div className="address-pill-meta">
                  Гр. {addr.group} • {addressDesc || getRegionShortTitle(addr.region)}
                </div>
              </div>
              <button
                type="button"
                className="address-pill-edit"
                title="Изменить название или адрес"
                onClick={(e) => {
                  e.stopPropagation();
                  onEdit(addr);
                }}
              >
                <Pencil size={12} />
              </button>
            </div>
          );
        })}

        <button type="button" className="add-address-pill" onClick={onAdd}>
          <Plus size={15} />
          <span>Новый адрес</span>
        </button>
      </div>
    </section>
  );
};
