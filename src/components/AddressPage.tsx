import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, Info, Loader2, Search, Sparkles } from 'lucide-react';
import { RegionId, SavedAddress } from '../services/scheduleNormalizer';
import {
  HouseLookupResult,
  StreetSearchItem,
  lookupHouseGroup,
  searchSettlements,
  searchStreets,
} from '../services/clientScheduleApi';
import {
  OblastFailureReason,
  lookupOblastGroup,
  oblastFailureText,
} from '../services/oblastLookup';
import { loadInviteCode, saveInviteCode } from '../services/pushSyncService';

interface AddressPageProps {
  initialAddress?: SavedAddress | null;
  kemGroups: string[];
  kremGroups: string[];
  onSave: (address: SavedAddress) => void;
  onDelete?: (id: string) => void;
  onClose: () => void;
}

const KYIV_FAILURE_TEXT: Record<'service' | 'street' | 'house' | 'group', string> = {
  service: 'Сервіс визначення групи зараз не відповідає. Спробуйте пізніше.',
  street: 'Не вдалося однозначно знайти цю вулицю в базі адрес.',
  house: 'Такого номера будинку немає в базі адрес для цієї вулиці.',
  group: 'Для цього будинку база адрес не дала однозначної групи.',
};

type FieldName = 'city' | 'street' | 'house';
type GroupVia = 'saved' | 'auto' | 'manual';

export const AddressPage: React.FC<AddressPageProps> = ({
  initialAddress,
  kemGroups,
  kremGroups,
  onSave,
  onDelete,
  onClose,
}) => {
  const [label, setLabel] = useState(initialAddress?.label || '');
  const [region, setRegion] = useState<RegionId>(initialAddress?.region || 'kem');
  const [city, setCity] = useState(
    initialAddress?.city || (initialAddress?.region === 'krem' ? '' : 'м. Київ')
  );
  const [street, setStreet] = useState(initialAddress?.street || '');
  const [streetId, setStreetId] = useState<number | undefined>(undefined);
  const [house, setHouse] = useState(initialAddress?.house || '');

  // null = not determined yet. Any edit of the address resets it: a group must never outlive the
  // address it was found for.
  const [group, setGroup] = useState<string | null>(initialAddress?.group ?? null);
  const [groupVia, setGroupVia] = useState<GroupVia>('saved');
  const [manualOpen, setManualOpen] = useState(false);
  const [groupFilter, setGroupFilter] = useState('');

  const [citySuggestions, setCitySuggestions] = useState<string[]>([]);
  const [streetSuggestions, setStreetSuggestions] = useState<StreetSearchItem[]>([]);
  const [houseSuggestions, setHouseSuggestions] = useState<HouseLookupResult[]>([]);
  const [openField, setOpenField] = useState<FieldName | null>(null);

  // Kyiv: automatic lookup while typing (debounced)
  const [kyivLooking, setKyivLooking] = useState(false);
  const [kyivFailure, setKyivFailure] = useState<string | null>(null);

  // Oblast: explicit lookup that takes up to ~90 s
  const [oblastStatus, setOblastStatus] = useState<'idle' | 'running'>('idle');
  const [oblastFailure, setOblastFailure] = useState<{
    reason: OblastFailureReason;
    candidates?: string[];
  } | null>(null);
  const [invite, setInvite] = useState(() => loadInviteCode());
  const [needInvite, setNeedInvite] = useState(() => !loadInviteCode());
  const lookupAbort = useRef<AbortController | null>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const availableGroups = region === 'kem' ? kemGroups : kremGroups;
  const filteredGroups = availableGroups.filter((g) =>
    !groupFilter.trim() ? true : g.includes(groupFilter.trim())
  );

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => () => lookupAbort.current?.abort(), []);

  const cancelOblastLookup = () => {
    lookupAbort.current?.abort();
    lookupAbort.current = null;
    setOblastStatus('idle');
  };

  /** Called by every edit of region / city / street / house. */
  const invalidateGroup = () => {
    cancelOblastLookup();
    setGroup(null);
    setManualOpen(false);
    setKyivFailure(null);
    setOblastFailure(null);
  };

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

  // Kyiv: house suggestions + automatic group, ONE debounced lookup (not one per keystroke).
  useEffect(() => {
    if (region === 'krem') {
      setHouseSuggestions([]);
      setKyivLooking(false);
      return;
    }
    let active = true;
    const houseQuery = house.trim();
    const wantsGroup = !!street.trim() && !!houseQuery;
    const timer = setTimeout(() => {
      if (wantsGroup) setKyivLooking(true);
      lookupHouseGroup(region, city, street, streetId, houseQuery).then((res) => {
        if (!active) return;
        setKyivLooking(false);
        setHouseSuggestions(res.houses || []);
        if (!wantsGroup) return;
        if (res.detectedGroup) {
          setGroup(res.detectedGroup);
          setGroupVia('auto');
          setKyivFailure(null);
        } else {
          setKyivFailure(KYIV_FAILURE_TEXT[res.failure ?? 'service']);
          setManualOpen(true);
        }
      });
    }, 350);
    return () => {
      active = false;
      clearTimeout(timer);
      setKyivLooking(false);
    };
  }, [region, city, street, streetId, house]);

  const hasAddress =
    !!street.trim() && !!house.trim() && (region === 'kem' || !!city.trim());

  const runOblastLookup = async () => {
    if (region !== 'krem' || !hasAddress || oblastStatus === 'running') return;
    if (!invite.trim()) {
      setNeedInvite(true);
      setOblastFailure({ reason: 'invite' });
      return;
    }
    const ctl = new AbortController();
    lookupAbort.current = ctl;
    setOblastFailure(null);
    setManualOpen(false);
    setOblastStatus('running');
    const result = await lookupOblastGroup({ city, street, house }, { invite, signal: ctl.signal });
    if (ctl.signal.aborted) return;
    lookupAbort.current = null;
    setOblastStatus('idle');
    if (result.ok) {
      saveInviteCode(invite);
      setNeedInvite(false);
      setGroup(result.group);
      setGroupVia('auto');
    } else {
      if (result.reason === 'invite') setNeedInvite(true);
      setOblastFailure({ reason: result.reason, candidates: result.candidates });
      const needsUserInput =
        result.reason === 'invite' ||
        result.reason === 'city_ambiguous' ||
        result.reason === 'street_ambiguous';
      if (!needsUserInput) setManualOpen(true);
    }
  };

  const pickOblastCandidate = (value: string) => {
    if (oblastFailure?.reason === 'city_ambiguous') {
      invalidateGroup();
      setCity(value);
    } else if (oblastFailure?.reason === 'street_ambiguous') {
      invalidateGroup();
      setStreet(value);
      setStreetId(undefined);
    }
  };

  const switchRegion = (next: RegionId) => {
    if (next === region) return;
    invalidateGroup();
    setRegion(next);
    setStreet('');
    setStreetId(undefined);
    setHouse('');
    setCity(next === 'kem' ? 'м. Київ' : '');
    setOpenField(next === 'krem' ? 'city' : null);
  };

  const selectCity = (value: string) => {
    invalidateGroup();
    setCity(value);
    setStreet('');
    setStreetId(undefined);
    setHouse('');
    setOpenField('street');
  };

  const selectStreet = (item: StreetSearchItem) => {
    invalidateGroup();
    setStreet(item.name);
    setStreetId(item.id);
    setOpenField('house');
  };

  const selectHouse = (item: HouseLookupResult) => {
    invalidateGroup();
    setHouse(item.house);
    if (item.group) {
      setGroup(item.group);
      setGroupVia('auto');
    }
    setOpenField(null);
  };

  const pickManualGroup = (g: string) => {
    setGroup(g);
    setGroupVia('manual');
  };

  const canSave = hasAddress && group !== null;
  const oblastNeedsLookup = region === 'krem' && group === null && !manualOpen;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (oblastNeedsLookup) {
      runOblastLookup();
      return;
    }
    if (!canSave || group === null) return;
    const autoName =
      [street.trim(), house.trim() ? `буд. ${house.trim()}` : ''].filter(Boolean).join(', ') ||
      `Адреса (гр. ${group})`;
    onSave({
      id: initialAddress?.id || `addr_${Date.now()}`,
      label: label.trim() || autoName,
      icon: initialAddress?.icon || '🏠',
      region,
      city: region === 'kem' ? 'м. Київ' : city.trim() || 'Київська обл.',
      street: street.trim(),
      house: house.trim(),
      group,
      notifyBeforeOff: initialAddress?.notifyBeforeOff ?? true,
      notifyBeforeOn: initialAddress?.notifyBeforeOn ?? true,
      notifyOnChange: initialAddress?.notifyOnChange ?? true,
      createdAt: initialAddress?.createdAt || new Date().toISOString(),
    });
  };

  const ctaLabel = (() => {
    if (oblastNeedsLookup) return oblastStatus === 'running' ? 'Шукаємо групу…' : 'Визначити групу';
    if (manualOpen && group === null) return 'Оберіть групу';
    if (manualOpen && groupVia === 'manual') return `Зберегти з групою ${group}`;
    return 'Зберегти';
  })();
  const ctaDisabled = oblastNeedsLookup
    ? !hasAddress || oblastStatus === 'running'
    : !canSave;

  const showSearching = oblastStatus === 'running' || (region === 'kem' && kyivLooking && group === null);
  const showBanner = group !== null && !manualOpen && !showSearching;
  const bannerSub =
    groupVia === 'auto'
      ? `визначено за адресою · ДТЕК ${region === 'kem' ? 'Київ' : 'Київська обл.'}`
      : 'збережена для цієї адреси';

  return (
    <div
      className="page-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="address-page-title"
      onClick={(e) => {
        if (!(e.target as HTMLElement).closest('.field')) setOpenField(null);
      }}
    >
      <form className="page" onSubmit={handleSubmit} noValidate>
        <header className="page-header">
          <button type="button" className="back-btn" aria-label="Назад" onClick={onClose}>
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <h1 id="address-page-title" className="page-title" tabIndex={-1} ref={titleRef}>
            {initialAddress ? 'Змінити адресу' : 'Нова адреса'}
          </h1>
        </header>

        <div className="segmented" role="tablist" aria-label="Регіон">
          {(
            [
              ['kem', 'Київ'],
              ['krem', 'Київська область'],
            ] as const
          ).map(([id, text]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={region === id}
              className={`segmented-item${region === id ? ' is-active' : ''}`}
              onClick={() => switchRegion(id)}
            >
              {text}
            </button>
          ))}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="addr-label">
            Назва
          </label>
          <input
            id="addr-label"
            className="field-input"
            type="text"
            value={label}
            placeholder={street ? `${street}${house ? `, буд. ${house}` : ''}` : 'Дім, Робота, Батьки…'}
            onChange={(e) => setLabel(e.target.value)}
            onFocus={() => setOpenField(null)}
            autoComplete="off"
          />
        </div>

        {region === 'krem' && (
          <div className="field">
            <label className="field-label" htmlFor="addr-city">
              Населений пункт
            </label>
            <input
              id="addr-city"
              className="field-input"
              type="text"
              value={city}
              placeholder="м. Бориспіль"
              onFocus={() => setOpenField('city')}
              onChange={(e) => {
                invalidateGroup();
                setCity(e.target.value);
                setOpenField('city');
              }}
              autoComplete="off"
            />
            {openField === 'city' && citySuggestions.length > 0 && (
              <ul className="suggest" role="listbox" aria-label="Населені пункти">
                {citySuggestions.slice(0, 50).map((s) => (
                  <li key={s} role="option" aria-selected={s === city}>
                    <button
                      type="button"
                      className="suggest-item"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectCity(s)}
                    >
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="field">
          <label className="field-label" htmlFor="addr-street">
            Вулиця
          </label>
          <input
            id="addr-street"
            className="field-input"
            type="text"
            value={street}
            placeholder={region === 'kem' ? 'Хрещатик' : 'вул. Київський Шлях'}
            onFocus={() => setOpenField('street')}
            onChange={(e) => {
              invalidateGroup();
              setStreet(e.target.value);
              setStreetId(undefined);
              setOpenField('street');
            }}
            autoComplete="off"
          />
          {openField === 'street' && streetSuggestions.length > 0 && (
            <ul className="suggest" role="listbox" aria-label="Вулиці">
              {streetSuggestions.slice(0, 50).map((item) => (
                <li key={`${item.id || ''}-${item.name}`} role="option" aria-selected={item.name === street}>
                  <button
                    type="button"
                    className="suggest-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectStreet(item)}
                  >
                    {item.name}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="field">
          <label className="field-label" htmlFor="addr-house">
            Будинок
          </label>
          <input
            id="addr-house"
            className="field-input"
            type="text"
            inputMode="text"
            value={house}
            placeholder="17"
            onFocus={() => setOpenField('house')}
            onChange={(e) => {
              invalidateGroup();
              setHouse(e.target.value);
              setOpenField('house');
            }}
            autoComplete="off"
          />
          {openField === 'house' && houseSuggestions.length > 0 && (
            <ul className="suggest" role="listbox" aria-label="Будинки">
              {houseSuggestions.slice(0, 100).map((h) => (
                <li key={h.house} role="option" aria-selected={h.house === house}>
                  <button
                    type="button"
                    className="suggest-item"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => selectHouse(h)}
                  >
                    <span>буд. {h.house}</span>
                    {h.group && <span className="suggest-badge">Група {h.group}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {showSearching && (
          <div className="result-card" role="status">
            <Loader2 size={28} className="spin" aria-hidden="true" />
            <span className="result-card-text">
              <span className="result-card-title">Шукаємо групу…</span>
              {region === 'krem' && (
                <span className="result-card-sub">
                  Зазвичай це займає до хвилини. Можна залишити екран відкритим.
                </span>
              )}
            </span>
          </div>
        )}

        {showBanner && (
          <div className="group-banner" role="status">
            <span className="group-banner-icon">
              <Check size={18} strokeWidth={2.6} aria-hidden="true" />
            </span>
            <span className="group-banner-text">
              <span className="group-banner-title">Група {group}</span>
              <span className="group-banner-sub">{bannerSub}</span>
            </span>
          </div>
        )}

        {region === 'krem' && oblastFailure && !manualOpen && (
          <div className="result-card result-card-warn" role="alert">
            <Info size={20} aria-hidden="true" />
            <span className="result-card-text">
              <span className="result-card-sub result-card-sub-first">
                {oblastFailureText(oblastFailure.reason)}
              </span>
              {oblastFailure.candidates && oblastFailure.candidates.length > 0 && (
                <span className="chip-row">
                  {oblastFailure.candidates.map((c) => (
                    <button key={c} type="button" className="chip" onClick={() => pickOblastCandidate(c)}>
                      {c}
                    </button>
                  ))}
                </span>
              )}
            </span>
          </div>
        )}

        {region === 'krem' && needInvite && (
          <div className="field">
            <label className="field-label" htmlFor="addr-invite">
              Код-запрошення
            </label>
            <input
              id="addr-invite"
              className="field-input"
              type="text"
              value={invite}
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              onFocus={() => setOpenField(null)}
              onChange={(e) => setInvite(e.target.value)}
            />
          </div>
        )}

        {manualOpen && (
          <section className="manual" aria-labelledby="manual-title">
            <div className="result-card result-card-warn" role="alert">
              <Info size={20} aria-hidden="true" />
              <span className="result-card-text">
                <span className="result-card-title">Не вдалося визначити групу</span>
                <span className="result-card-sub">
                  {region === 'kem'
                    ? kyivFailure
                    : oblastFailure
                    ? oblastFailureText(oblastFailure.reason)
                    : 'Сайт ДТЕК зараз недоступний або не знайшов адресу. Спробуйте ще раз пізніше.'}
                </span>
              </span>
            </div>
            {region === 'krem' && (
              <button
                type="button"
                className="outline-btn"
                disabled={oblastStatus === 'running'}
                onClick={runOblastLookup}
              >
                Спробувати ще раз
              </button>
            )}

            <h2 id="manual-title" className="field-label manual-title">
              Або виберіть групу вручну
            </h2>
            <p className="manual-text">
              Номер групи вказано в платіжці за світло або на сайті ДТЕК. Якщо вибрати неправильно,
              графік буде чужим.
            </p>

            {availableGroups.length > 12 && (
              <div className="field-search">
                <Search size={16} aria-hidden="true" />
                <input
                  className="field-input field-input-compact"
                  type="text"
                  inputMode="decimal"
                  aria-label="Фільтр груп"
                  placeholder="Фільтр, наприклад 20"
                  value={groupFilter}
                  onChange={(e) => setGroupFilter(e.target.value)}
                />
              </div>
            )}

            <div className="group-grid" role="radiogroup" aria-label="Група відключень">
              {filteredGroups.map((g) => (
                <button
                  key={g}
                  type="button"
                  role="radio"
                  aria-checked={group === g}
                  className={`group-cell${group === g ? ' is-selected' : ''}`}
                  onClick={() => pickManualGroup(g)}
                >
                  {g}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="page-actions">
          <button type="submit" className="cta-btn" disabled={ctaDisabled}>
            {oblastStatus === 'running' ? (
              <span className="cta-inline">
                <Loader2 size={18} className="spin" aria-hidden="true" /> {ctaLabel}
              </span>
            ) : (
              ctaLabel
            )}
          </button>
          {oblastNeedsLookup && (
            <p className="page-foot">
              <Sparkles size={13} aria-hidden="true" /> Запит іде через сервер, окремо від вашого
              пристрою
            </p>
          )}
          {initialAddress && onDelete && (
            <button
              type="button"
              className="danger-text-btn"
              onClick={() => {
                if (confirmDelete) onDelete(initialAddress.id);
                else setConfirmDelete(true);
              }}
              onBlur={() => setConfirmDelete(false)}
            >
              {confirmDelete ? 'Так, видалити цю адресу' : 'Видалити адресу'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
};
