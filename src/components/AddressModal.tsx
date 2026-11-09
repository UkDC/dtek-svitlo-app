import React, { useEffect, useState } from 'react';
import {
  Building2,
  Check,
  ChevronDown,
  ExternalLink,
  Home,
  MapPin,
  Search,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { RegionId, SavedAddress } from '../services/scheduleNormalizer';
import {
  ADDRESS_ICONS,
  getDtekOfficialUrl,
} from '../services/addressCatalog';
import {
  HouseLookupResult,
  StreetSearchItem,
  lookupHouseGroup,
  searchSettlements,
  searchStreets,
} from '../services/clientScheduleApi';

interface AddressModalProps {
  initialAddress?: SavedAddress | null;
  kemGroups: string[];
  kremGroups: string[];
  onSave: (address: SavedAddress) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

const KYIV_FAILURE_TEXT: Record<'service' | 'street' | 'house' | 'group', string> = {
  service: 'Сервіс визначення групи зараз не відповідає — спробуйте пізніше.',
  street: 'Не вдалося однозначно знайти цю вулицю в базі адрес.',
  house: 'Такого номера будинку немає в базі адрес для цієї вулиці.',
  group: 'Для цього будинку база адрес не дала однозначної групи.',
};

export const AddressModal: React.FC<AddressModalProps> = ({
  initialAddress,
  kemGroups,
  kremGroups,
  onSave,
  onDelete,
  onClose,
}) => {
  const [label, setLabel] = useState(initialAddress?.label || '');
  const [icon, setIcon] = useState(initialAddress?.icon || '🏠');
  const [region, setRegion] = useState<RegionId>(
    initialAddress?.region || 'kem'
  );
  const [city, setCity] = useState(
    initialAddress?.city || (initialAddress?.region === 'krem' ? '' : 'м. Київ')
  );
  const [street, setStreet] = useState(initialAddress?.street || '');
  const [streetId, setStreetId] = useState<number | undefined>(undefined);
  const [house, setHouse] = useState(initialAddress?.house || '');
  const [group, setGroup] = useState(initialAddress?.group || '1.1');
  const [groupFilter, setGroupFilter] = useState('');

  const [notifyBeforeOff, setNotifyBeforeOff] = useState(
    initialAddress?.notifyBeforeOff ?? true
  );
  const [notifyBeforeOn, setNotifyBeforeOn] = useState(
    initialAddress?.notifyBeforeOn ?? true
  );
  const [notifyOnChange, setNotifyOnChange] = useState(
    initialAddress?.notifyOnChange ?? true
  );

  const [citySuggestions, setCitySuggestions] = useState<string[]>([]);
  const [streetSuggestions, setStreetSuggestions] = useState<StreetSearchItem[]>([]);
  const [houseSuggestions, setHouseSuggestions] = useState<HouseLookupResult[]>([]);
  const [autoDetectedNote, setAutoDetectedNote] = useState<string>('');

  const [showCityDropdown, setShowCityDropdown] = useState(false);
  const [showStreetDropdown, setShowStreetDropdown] = useState(false);
  const [showHouseDropdown, setShowHouseDropdown] = useState(false);

  const availableGroups = region === 'kem' ? kemGroups : kremGroups;
  const filteredGroups = availableGroups.filter((g) =>
    !groupFilter.trim() ? true : g.includes(groupFilter.trim())
  );

  // Keep selected group valid when switching between Kyiv (60 groups) and Oblast (12 groups)
  useEffect(() => {
    const list = region === 'kem' ? kemGroups : kremGroups;
    if (list.length > 0 && !list.includes(group)) {
      setGroup(list[0] || '1.1');
    }
  }, [region, kemGroups, kremGroups]);

  useEffect(() => {
    let active = true;
    if (region === 'krem') {
      searchSettlements('krem', city.trim()).then((res) => {
        if (active) setCitySuggestions(res);
      });
    } else {
      setCitySuggestions([]);
    }
    return () => {
      active = false;
    };
  }, [region, city]);

  useEffect(() => {
    let active = true;
    searchStreets(region, city, street.trim()).then((res) => {
      if (active) setStreetSuggestions(res);
    });
    return () => {
      active = false;
    };
  }, [region, city, street]);

  // House suggestions + automatic group, ONE debounced lookup (not one per keystroke).
  useEffect(() => {
    let active = true;
    const houseQuery = house.trim();
    const timer = setTimeout(() => {
      lookupHouseGroup(region, city, street, streetId, houseQuery).then((res) => {
        if (!active) return;
        setHouseSuggestions(res.houses || []);
        if (!street.trim() || !houseQuery) return;
        if (res.detectedGroup) {
          setGroup(res.detectedGroup);
          setAutoDetectedNote(
            `Автоматично обрано Групу ${res.detectedGroup} для «${street.trim()}, ${houseQuery}»`
          );
        } else {
          setAutoDetectedNote(
            region === 'krem'
              ? 'Для Київської області групу автоматично визначити поки неможливо. Подивіться свою чергу на dtek-krem.com.ua/ua/shutdowns за своєю адресою та оберіть її нижче.'
              : `${KYIV_FAILURE_TEXT[res.failure ?? 'service']} Оберіть групу нижче (перевірте на сайті ДТЕК: dtek-kem.com.ua).`
          );
        }
      });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [region, city, street, streetId, house]);

  const selectCityOption = (selectedCity: string) => {
    setCity(selectedCity);
    setStreet('');
    setHouse('');
    setShowCityDropdown(false);
    setShowStreetDropdown(true);
    setShowHouseDropdown(false);
  };

  const selectStreetOption = (item: StreetSearchItem) => {
    setStreet(item.name);
    setStreetId(item.id);
    setShowStreetDropdown(false);
    setShowCityDropdown(false);
    setShowHouseDropdown(true);
  };

  const selectHouseOption = (item: HouseLookupResult) => {
    setHouse(item.house);
    if (item.group) {
      setGroup(item.group);
      setAutoDetectedNote(
        `Автоматически выбрана Група ${item.group} для «${street.trim() || city}, буд. ${item.house}»`
      );
    }
    setShowHouseDropdown(false);
    setShowStreetDropdown(false);
    setShowCityDropdown(false);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const autoName =
      [street.trim(), house.trim() ? `буд. ${house.trim()}` : '']
        .filter(Boolean)
        .join(', ') ||
      (region === 'krem' && city.trim() ? city.trim() : '') ||
      `Адрес (Гр. ${group})`;

    const finalLabel = label.trim() || autoName;

    const saved: SavedAddress = {
      id: initialAddress?.id || `addr_${Date.now()}`,
      label: finalLabel,
      icon,
      region,
      city: region === 'kem' ? 'м. Київ' : city.trim() || 'Київська обл.',
      street: street.trim() || 'вул. Центральна',
      house: house.trim() || '1',
      group: group.trim() || '1.1',
      notifyBeforeOff,
      notifyBeforeOn,
      notifyOnChange,
      createdAt: initialAddress?.createdAt || new Date().toISOString(),
    };

    onSave(saved);
  };

  return (
    <div
      className="modal-backdrop"
      onClick={() => {
        setShowCityDropdown(false);
        setShowStreetDropdown(false);
        setShowHouseDropdown(false);
        onClose();
      }}
    >
      <div
        className="modal-sheet"
        onClick={(e) => {
          e.stopPropagation();
        }}
      >
        <div className="modal-header">
          <h2 className="modal-title">
            {initialAddress ? 'Редактировать адрес' : 'Добавить свой адрес'}
          </h2>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <form
          onSubmit={handleSubmit}
          style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}
        >
          {/* 1. Operator / Region */}
          <div className="form-group">
            <label className="form-label">1. Электросеть ДТЭК</label>
            <div className="region-toggle-grid">
              <button
                type="button"
                className={`region-card-btn ${region === 'kem' ? 'selected' : ''}`}
                onClick={() => {
                  setRegion('kem');
                  setCity('м. Київ');
                  setShowCityDropdown(false);
                  setAutoDetectedNote('');
                }}
              >
                <span className="region-card-title">ДТЭК Киев</span>
                <span className="region-card-desc">dtek-kem.com.ua (г. Киев)</span>
              </button>

              <button
                type="button"
                className={`region-card-btn ${region === 'krem' ? 'selected' : ''}`}
                onClick={() => {
                  setRegion('krem');
                  if (city === 'м. Київ') setCity('');
                  setShowCityDropdown(true);
                  setShowStreetDropdown(false);
                  setShowHouseDropdown(false);
                  setAutoDetectedNote('');
                }}
              >
                <span className="region-card-title">Киевская область</span>
                <span className="region-card-desc">
                  dtek-krem.com.ua (1 038+ нас. пунктов)
                </span>
              </button>
            </div>
          </div>

          {/* 2. City / Village (for Kyiv Oblast) with Autocomplete Dropdown */}
          {region === 'krem' && (
            <div className="form-group autocomplete-wrapper">
              <label className="form-label">
                <span>Населённый пункт (Область)</span>
                <span style={{ fontSize: '11px', opacity: 0.75 }}>
                  Выберите из списка или начните ввод
                </span>
              </label>
              <div className="input-with-clear">
                <input
                  type="text"
                  className="text-input"
                  style={{ paddingRight: '58px' }}
                  placeholder="Например: м. Бровари, м. Ірпінь, с. Гатне…"
                  value={city}
                  onFocus={() => {
                    setShowCityDropdown(true);
                    setShowStreetDropdown(false);
                    setShowHouseDropdown(false);
                  }}
                  onClick={() => {
                    setShowCityDropdown(true);
                    setShowStreetDropdown(false);
                    setShowHouseDropdown(false);
                  }}
                  onChange={(e) => {
                    setCity(e.target.value);
                    setShowCityDropdown(true);
                  }}
                  autoComplete="off"
                />
                {city && (
                  <button
                    type="button"
                    className="input-clear-btn"
                    style={{ right: '32px' }}
                    title="Очистить"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setCity('');
                      setShowCityDropdown(true);
                    }}
                  >
                    <X size={13} />
                  </button>
                )}
                <button
                  type="button"
                  className="input-clear-btn"
                  style={{ right: '6px' }}
                  title="Открыть список населённых пунктов"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setShowCityDropdown((prev) => !prev);
                    setShowStreetDropdown(false);
                    setShowHouseDropdown(false);
                  }}
                >
                  <ChevronDown size={14} />
                </button>
              </div>

              {showCityDropdown && citySuggestions.length > 0 && (
                <div className="autocomplete-dropdown">
                  <div className="autocomplete-header">
                    <span>
                      Населённые пункты ({citySuggestions.length}) — нажмите для выбора
                    </span>
                    <button
                      type="button"
                      style={{
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        fontSize: '11px',
                        cursor: 'pointer',
                      }}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setShowCityDropdown(false);
                      }}
                    >
                      Скрыть
                    </button>
                  </div>
                  {citySuggestions.slice(0, 50).map((s) => (
                    <button
                      key={s}
                      type="button"
                      className="autocomplete-item"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        selectCityOption(s);
                      }}
                      onClick={() => selectCityOption(s)}
                    >
                      <span className="autocomplete-item-main">
                        <MapPin
                          size={14}
                          style={{ color: 'var(--accent-primary)', flexShrink: 0 }}
                        />
                        <span>{s}</span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* 3. Street (Full-width with Autocomplete Dropdown) */}
          <div className="form-group autocomplete-wrapper">
            <label className="form-label">
              <span>2. Улица</span>
              <span style={{ fontSize: '11px', opacity: 0.75 }}>
                {region === 'kem'
                  ? 'Поиск по 3 406 улицам Киева'
                  : `Улицы (${city || 'Киевская обл.'})`}
              </span>
            </label>
            <div className="input-with-clear">
              <input
                type="text"
                className="text-input"
                style={{ paddingRight: '58px' }}
                placeholder={
                  region === 'kem'
                    ? 'Начните ввод: Хрещатик, Саксаганського…'
                    : 'Начните ввод: Центральна, Лісова, Шкільна…'
                }
                value={street}
                onFocus={() => {
                  setShowStreetDropdown(true);
                  setShowCityDropdown(false);
                  setShowHouseDropdown(false);
                }}
                onClick={() => {
                  setShowStreetDropdown(true);
                  setShowCityDropdown(false);
                  setShowHouseDropdown(false);
                }}
                onChange={(e) => {
                  setStreet(e.target.value);
                  setStreetId(undefined);
                  setShowStreetDropdown(true);
                }}
                autoComplete="off"
              />
              {street && (
                <button
                  type="button"
                  className="input-clear-btn"
                  style={{ right: '32px' }}
                  title="Очистить улицу"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setStreet('');
                    setStreetId(undefined);
                    setAutoDetectedNote('');
                    setShowStreetDropdown(true);
                  }}
                >
                  <X size={13} />
                </button>
              )}
              <button
                type="button"
                className="input-clear-btn"
                style={{ right: '6px' }}
                title="Открыть список улиц"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowStreetDropdown((prev) => !prev);
                  setShowCityDropdown(false);
                  setShowHouseDropdown(false);
                }}
              >
                <ChevronDown size={14} />
              </button>
            </div>

            {showStreetDropdown && streetSuggestions.length > 0 && (
              <div className="autocomplete-dropdown">
                <div className="autocomplete-header">
                  <span>
                    Подсказки улиц ({streetSuggestions.length}) — нажмите для выбора
                  </span>
                  <button
                    type="button"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      fontSize: '11px',
                      cursor: 'pointer',
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setShowStreetDropdown(false);
                    }}
                  >
                    Скрыть
                  </button>
                </div>
                {streetSuggestions.slice(0, 50).map((item) => (
                  <button
                    key={`${item.id || ''}-${item.name}`}
                    type="button"
                    className="autocomplete-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectStreetOption(item);
                    }}
                    onClick={() => selectStreetOption(item)}
                  >
                    <span className="autocomplete-item-main">
                      <Building2
                        size={14}
                        style={{ color: 'var(--accent-primary)', flexShrink: 0 }}
                      />
                      <span>{item.name}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* 4. House Number (Full-width with Autocomplete Dropdown + Group Badges) */}
          <div className="form-group autocomplete-wrapper">
            <label className="form-label">
              <span>3. Номер дома</span>
              <span style={{ fontSize: '11px', opacity: 0.75 }}>
                Выберите из списка или введите номер
              </span>
            </label>
            <div className="input-with-clear">
              <input
                type="text"
                className="text-input"
                style={{ paddingRight: '58px' }}
                placeholder="Например: 12, 3, 22…"
                value={house}
                onFocus={() => {
                  setShowHouseDropdown(true);
                  setShowStreetDropdown(false);
                  setShowCityDropdown(false);
                }}
                onClick={() => {
                  setShowHouseDropdown(true);
                  setShowStreetDropdown(false);
                  setShowCityDropdown(false);
                }}
                onChange={(e) => {
                  setHouse(e.target.value);
                  setShowHouseDropdown(true);
                }}
                autoComplete="off"
              />
              {house && (
                <button
                  type="button"
                  className="input-clear-btn"
                  style={{ right: '32px' }}
                  title="Очистить номер дома"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setHouse('');
                    setShowHouseDropdown(true);
                  }}
                >
                  <X size={13} />
                </button>
              )}
              <button
                type="button"
                className="input-clear-btn"
                style={{ right: '6px' }}
                title="Открыть список домов"
                onMouseDown={(e) => {
                  e.preventDefault();
                  setShowHouseDropdown((prev) => !prev);
                  setShowStreetDropdown(false);
                  setShowCityDropdown(false);
                }}
              >
                <ChevronDown size={14} />
              </button>
            </div>

            {showHouseDropdown && houseSuggestions.length > 0 && (
              <div className="autocomplete-dropdown">
                <div className="autocomplete-header">
                  <span>
                    Подсказки домов ({houseSuggestions.length}) — нажмите для выбора
                  </span>
                  <button
                    type="button"
                    style={{
                      border: 'none',
                      background: 'transparent',
                      color: 'var(--text-secondary)',
                      fontSize: '11px',
                      cursor: 'pointer',
                    }}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setShowHouseDropdown(false);
                    }}
                  >
                    Скрыть
                  </button>
                </div>
                {houseSuggestions.slice(0, 100).map((h) => (
                  <button
                    key={h.house}
                    type="button"
                    className="autocomplete-item"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      selectHouseOption(h);
                    }}
                    onClick={() => selectHouseOption(h)}
                  >
                    <span className="autocomplete-item-main">
                      <Home
                        size={13}
                        style={{ color: 'var(--accent-primary)', flexShrink: 0 }}
                      />
                      <span>буд. {h.house}</span>
                    </span>
                    {h.group && (
                      <span className="autocomplete-badge">Гр. {h.group}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {autoDetectedNote && (
            <div className="status-toast">
              <Sparkles size={13} style={{ display: 'inline', marginRight: 5 }} />
              {autoDetectedNote}
            </div>
          )}

          {/* 5. Custom User-Defined Address Name (Optional — auto-filled if left blank) */}
          <div className="form-group">
            <label className="form-label">
              <span>4. Название адреса (устанавливаете сами)</span>
              <span style={{ fontSize: '11px', opacity: 0.8 }}>
                Или оставьте пустым
              </span>
            </label>
            <input
              type="text"
              className="text-input"
              placeholder={
                street
                  ? `Авто: ${street}${house ? ', буд. ' + house : ''}`
                  : 'Например: Моя квартира, Офис, Родители, Дача…'
              }
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onFocus={() => {
                setShowCityDropdown(false);
                setShowStreetDropdown(false);
                setShowHouseDropdown(false);
              }}
            />
          </div>

          {/* Icon Picker */}
          <div className="form-group">
            <label className="form-label">Иконка адреса</label>
            <div className="icon-picker-grid">
              {ADDRESS_ICONS.map((item) => (
                <button
                  key={item.emoji}
                  type="button"
                  className={`icon-choice-btn ${
                    icon === item.emoji ? 'selected' : ''
                  }`}
                  onClick={() => setIcon(item.emoji)}
                  title={item.label}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
          </div>

          {/* 6. Group / Queue Selection */}
          <div className="form-group">
            <div className="form-label">
              <span>5. Очередь / Группа ДТЭК (выбрана: {group})</span>
              <a
                href={getDtekOfficialUrl(region)}
                target="_blank"
                rel="noopener noreferrer"
                className="external-link-chip"
              >
                Проверить на сайте ДТЭК <ExternalLink size={11} />
              </a>
            </div>

            {availableGroups.length > 12 && (
              <div style={{ position: 'relative', marginBottom: '4px' }}>
                <input
                  type="text"
                  className="text-input"
                  style={{
                    paddingLeft: '32px',
                    paddingTop: '8px',
                    paddingBottom: '8px',
                    fontSize: '13px',
                  }}
                  placeholder="Быстрый фильтр группы (например: 36.1, 20.1 или 3.1)…"
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                />
                <Search
                  size={14}
                  style={{
                    position: 'absolute',
                    left: '11px',
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-secondary)',
                  }}
                />
              </div>
            )}

            <div className="group-grid-selector">
              {filteredGroups.map((g) => (
                <button
                  key={g}
                  type="button"
                  className={`group-option-btn ${group === g ? 'selected' : ''}`}
                  onClick={() => setGroup(g)}
                >
                  Гр. {g}
                </button>
              ))}
            </div>
          </div>

          {/* 7. Notification Preferences for this address */}
          <div className="form-group">
            <label className="form-label">Уведомления по этому адресу</label>

            <div className="toggle-row">
              <div className="toggle-info">
                <span className="toggle-title">За 30 минут до выключения</span>
                <span className="toggle-desc">
                  Предупредить перед началом слота отключения
                </span>
              </div>
              <button
                type="button"
                className={`ios-switch ${notifyBeforeOff ? 'checked' : ''}`}
                onClick={() => setNotifyBeforeOff(!notifyBeforeOff)}
              >
                <span className="ios-switch-thumb" />
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <span className="toggle-title">За 30 минут до включения</span>
                <span className="toggle-desc">
                  Сообщить о скором восстановлении электроснабжения
                </span>
              </div>
              <button
                type="button"
                className={`ios-switch ${notifyBeforeOn ? 'checked' : ''}`}
                onClick={() => setNotifyBeforeOn(!notifyBeforeOn)}
              >
                <span className="ios-switch-thumb" />
              </button>
            </div>

            <div className="toggle-row">
              <div className="toggle-info">
                <span className="toggle-title">Изменения графика в течение дня</span>
                <span className="toggle-desc">
                  Мгновенный пуш при корректировке часов ДТЭК
                </span>
              </div>
              <button
                type="button"
                className={`ios-switch ${notifyOnChange ? 'checked' : ''}`}
                onClick={() => setNotifyOnChange(!notifyOnChange)}
              >
                <span className="ios-switch-thumb" />
              </button>
            </div>
          </div>

          <button type="submit" className="primary-btn">
            <Check size={17} />
            <span>
              {initialAddress ? 'Сохранить изменения' : 'Сохранить адрес'}
            </span>
          </button>

          {initialAddress && onDelete && (
            <button
              type="button"
              className="danger-btn"
              onClick={() => onDelete(initialAddress.id)}
            >
              <Trash2 size={16} />
              <span>Удалить этот адрес</span>
            </button>
          )}
        </form>
      </div>
    </div>
  );
};
