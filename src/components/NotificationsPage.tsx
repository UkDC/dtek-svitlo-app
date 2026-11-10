import React, { useEffect, useRef, useState } from 'react';
import { BellOff, BellRing, ChevronDown, ChevronLeft, Smartphone } from 'lucide-react';
import { SavedAddress } from '../services/scheduleNormalizer';
import {
  CloudSyncError,
  QuietHoursSettings,
  disablePush,
  loadInviteCode,
  registerAndSubscribePush,
  renewPushSubscription,
  saveInviteCode,
  syncSubscriberState,
  triggerTestNotification,
} from '../services/pushSyncService';
import { regionName } from './AddressSheet';

export type ThemePreference = 'system' | 'light' | 'dark';

const CLOUD_ERROR_TEXT: Record<CloudSyncError, string> = {
  'no-invite': 'Введіть код-запрошення (розділ «Додатково»), інакше сповіщення не прийдуть.',
  invite: 'Код-запрошення не підійшов. Перевірте його в того, хто вас запросив.',
  invalid: 'Сервер відхилив дані пристрою. Спробуйте «Створити підписку заново».',
  network: 'Немає звʼязку з хмарним сховищем. Повторіть пізніше.',
};

const THEME_OPTIONS: Array<[ThemePreference, string]> = [
  ['system', 'Системна'],
  ['light', 'Світла'],
  ['dark', 'Темна'],
];

interface NotificationsPageProps {
  address: SavedAddress | undefined;
  addresses: SavedAddress[];
  quietHours: QuietHoursSettings;
  pushEnabled: boolean;
  themePref: ThemePreference;
  onUpdateAddress: (id: string, patch: Partial<SavedAddress>) => void;
  onUpdateQuietHours: (next: QuietHoursSettings) => void;
  onPushStatusChange: (enabled: boolean) => void;
  onThemeChange: (next: ThemePreference) => void;
  onClose: () => void;
}

const Switch: React.FC<{
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}> = ({ checked, label, onChange }) => (
  <button
    type="button"
    role="switch"
    aria-checked={checked}
    aria-label={label}
    className={`switch${checked ? ' is-on' : ''}`}
    onClick={() => onChange(!checked)}
  >
    <span className="switch-thumb" />
  </button>
);

function permissionHint(): { text: string; tone: 'ok' | 'warn' } | null {
  if (typeof Notification === 'undefined') {
    return { text: 'Додайте застосунок на екран «Додому», щоб працювали сповіщення.', tone: 'warn' };
  }
  if (Notification.permission === 'denied') {
    return {
      text: 'Сповіщення заблоковані в налаштуваннях iOS (Параметри → Сповіщення).',
      tone: 'warn',
    };
  }
  return null;
}

export const NotificationsPage: React.FC<NotificationsPageProps> = ({
  address,
  addresses,
  quietHours,
  pushEnabled,
  themePref,
  onUpdateAddress,
  onUpdateQuietHours,
  onPushStatusChange,
  onThemeChange,
  onClose,
}) => {
  const [statusMessage, setStatusMessage] = useState('');
  const [isBusy, setIsBusy] = useState(false);
  const [invite, setInvite] = useState(() => loadInviteCode());
  const [advancedOpen, setAdvancedOpen] = useState(() => !loadInviteCode());
  const [confirmDisable, setConfirmDisable] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const handleEnable = async () => {
    setIsBusy(true);
    setStatusMessage('Підключаємо сповіщення iOS…');
    try {
      const res = await registerAndSubscribePush();
      if (!res.ok) {
        setStatusMessage(res.error || 'Не вдалося увімкнути сповіщення.');
        return;
      }
      onPushStatusChange(true);
      const sync = await syncSubscriberState(addresses, quietHours, res.subscription);
      setStatusMessage(
        sync.syncedCloud || sync.syncedBackend
          ? 'Сповіщення увімкнено.'
          : `Сповіщення iOS увімкнено, але хмара не підключена. ${CLOUD_ERROR_TEXT[sync.cloudError ?? 'network']}`
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleTest = async () => {
    setIsBusy(true);
    setStatusMessage('Надсилаємо тестове сповіщення…');
    try {
      const result = await triggerTestNotification(address?.label);
      setStatusMessage(result.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleDisable = async () => {
    if (!confirmDisable) {
      setConfirmDisable(true);
      return;
    }
    setConfirmDisable(false);
    setIsBusy(true);
    try {
      const res = await disablePush();
      if (res.ok) {
        onPushStatusChange(false);
        setStatusMessage(
          res.cloudRemoved
            ? 'Сповіщення вимкнено.'
            : 'Сповіщення на цьому пристрої вимкнено. Запис у хмарі не вдалося прибрати зараз, він зникне сам.'
        );
      } else {
        setStatusMessage('Не вдалося вимкнути підписку. Спробуйте ще раз.');
      }
    } finally {
      setIsBusy(false);
    }
  };

  const handleSaveInvite = async () => {
    saveInviteCode(invite);
    setIsBusy(true);
    try {
      const res = await syncSubscriberState(addresses, quietHours);
      setStatusMessage(
        res.syncedCloud || res.syncedBackend
          ? 'Готово: пристрій зареєстровано, сповіщення надходитимуть.'
          : CLOUD_ERROR_TEXT[res.cloudError ?? 'network']
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleRenew = async () => {
    setIsBusy(true);
    setStatusMessage('Створюємо підписку цього iPhone заново…');
    try {
      const res = await renewPushSubscription();
      if (!res.ok || !res.subscription) {
        setStatusMessage(res.error || 'Не вдалося створити підписку заново.');
        return;
      }
      onPushStatusChange(true);
      const sync = await syncSubscriberState(addresses, quietHours, res.subscription);
      setStatusMessage(
        sync.syncedCloud
          ? 'Підписку створено заново: попередня адреса доставки більше не працює.'
          : CLOUD_ERROR_TEXT[sync.cloudError ?? 'network']
      );
    } finally {
      setIsBusy(false);
    }
  };

  const hint = permissionHint();
  const addressLine = address ? `для адреси «${address.label}» · Група ${address.group}` : '';

  return (
    <div
      className="page-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="notify-page-title"
    >
      <div className="page">
        <header className="page-header">
          <button type="button" className="back-btn" aria-label="Назад" onClick={onClose}>
            <ChevronLeft size={24} aria-hidden="true" />
          </button>
          <h1 id="notify-page-title" className="page-title" tabIndex={-1} ref={titleRef}>
            Сповіщення
          </h1>
        </header>

        {pushEnabled ? (
          <div className="group-banner">
            <span className="group-banner-icon">
              <BellRing size={18} aria-hidden="true" />
            </span>
            <span className="group-banner-text">
              <span className="group-banner-title">Увімкнено на цьому пристрої</span>
              {addressLine && <span className="group-banner-sub">{addressLine}</span>}
            </span>
          </div>
        ) : (
          <div className="result-card">
            <BellOff size={26} aria-hidden="true" />
            <span className="result-card-text">
              <span className="result-card-title">Сповіщення вимкнені</span>
              <span className="result-card-sub">
                Увімкніть їх, щоб отримувати попередження, коли застосунок закритий.
              </span>
              {hint && <span className="result-card-sub result-card-hint">{hint.text}</span>}
            </span>
          </div>
        )}

        {!pushEnabled && (
          <button type="button" className="cta-btn page-cta-inline" onClick={handleEnable} disabled={isBusy}>
            Увімкнути сповіщення
          </button>
        )}

        {address && (
          <>
            <h2 className="section-label">Коли нагадувати</h2>
            <div className="settings-card">
              <div className="settings-row">
                <span className="settings-text">
                  <span className="settings-title">Перед відключенням</span>
                  <span className="settings-sub">за 30 хвилин</span>
                </span>
                <Switch
                  checked={address.notifyBeforeOff}
                  label="Перед відключенням"
                  onChange={(v) => onUpdateAddress(address.id, { notifyBeforeOff: v })}
                />
              </div>
              <div className="settings-row">
                <span className="settings-text">
                  <span className="settings-title">Перед увімкненням</span>
                  <span className="settings-sub">за 30 хвилин</span>
                </span>
                <Switch
                  checked={address.notifyBeforeOn}
                  label="Перед увімкненням"
                  onChange={(v) => onUpdateAddress(address.id, { notifyBeforeOn: v })}
                />
              </div>
              <div className="settings-row">
                <span className="settings-text">
                  <span className="settings-title">Зміна графіка</span>
                  <span className="settings-sub">якщо ДТЕК оновив розклад</span>
                </span>
                <Switch
                  checked={address.notifyOnChange}
                  label="Зміна графіка"
                  onChange={(v) => onUpdateAddress(address.id, { notifyOnChange: v })}
                />
              </div>
            </div>
            <p className="page-note">
              Налаштування діють для адреси «{address.label}» ({regionName(address)}). Час
              нагадування зараз фіксований: за 30 хвилин, ±кілька хвилин.
            </p>
          </>
        )}

        {pushEnabled && (
          <>
            <h2 className="section-label">Перевірка</h2>
            <button type="button" className="outline-btn" onClick={handleTest} disabled={isBusy}>
              Надіслати тестове сповіщення
            </button>
          </>
        )}

        {statusMessage && (
          <p className="page-status" role="status">
            {statusMessage}
          </p>
        )}

        <button
          type="button"
          className="disclosure"
          aria-expanded={advancedOpen}
          onClick={() => setAdvancedOpen((v) => !v)}
        >
          <span>Додатково</span>
          <ChevronDown size={18} aria-hidden="true" className={advancedOpen ? 'is-open' : ''} />
        </button>

        {advancedOpen && (
          <div className="advanced">
            <h2 className="section-label">Вигляд</h2>
            <div className="segmented" role="radiogroup" aria-label="Тема">
              {THEME_OPTIONS.map(([id, text]) => (
                <button
                  key={id}
                  type="button"
                  role="radio"
                  aria-checked={themePref === id}
                  className={`segmented-item${themePref === id ? ' is-active' : ''}`}
                  onClick={() => onThemeChange(id)}
                >
                  {text}
                </button>
              ))}
            </div>

            <h2 className="section-label">Тихі години</h2>
            <div className="settings-card">
              <div className="settings-row">
                <span className="settings-text">
                  <span className="settings-title">Не турбувати вночі</span>
                  <span className="settings-sub">
                    без сповіщень з {quietHours.start} до {quietHours.end}
                  </span>
                </span>
                <Switch
                  checked={quietHours.enabled}
                  label="Не турбувати вночі"
                  onChange={(v) => onUpdateQuietHours({ ...quietHours, enabled: v })}
                />
              </div>
              {quietHours.enabled && (
                <div className="time-row">
                  <label className="time-field">
                    <span className="field-label">З</span>
                    <input
                      type="time"
                      className="field-input"
                      value={quietHours.start}
                      onChange={(e) => onUpdateQuietHours({ ...quietHours, start: e.target.value })}
                    />
                  </label>
                  <label className="time-field">
                    <span className="field-label">До</span>
                    <input
                      type="time"
                      className="field-input"
                      value={quietHours.end}
                      onChange={(e) => onUpdateQuietHours({ ...quietHours, end: e.target.value })}
                    />
                  </label>
                </div>
              )}
            </div>

            <h2 className="section-label">Код-запрошення</h2>
            <p className="page-note page-note-first">
              Щоб сповіщення приходили, коли застосунок закритий, пристрій реєструється в закритому
              сховищі. Потрібен код-запрошення. Зберігається лише спосіб доставки та номер групи,
              адреса лишається на телефоні.
            </p>
            <input
              type="text"
              className="field-input"
              aria-label="Код-запрошення"
              placeholder="XXXX-XXXX-XXXX-XXXX"
              autoCapitalize="characters"
              autoCorrect="off"
              autoComplete="off"
              value={invite}
              onChange={(e) => setInvite(e.target.value)}
            />
            <button
              type="button"
              className="outline-btn advanced-btn"
              onClick={handleSaveInvite}
              disabled={isBusy}
            >
              Зберегти код і зареєструвати пристрій
            </button>
            <button
              type="button"
              className="outline-btn advanced-btn"
              onClick={handleRenew}
              disabled={isBusy}
            >
              Створити підписку заново
            </button>

            <div className="tip-card">
              <Smartphone size={18} aria-hidden="true" />
              <span>
                Сповіщення працюють, лише якщо застосунок додано на головний екран iPhone: Safari →
                «Поділитися» → «На екран „Додому“».
              </span>
            </div>
          </div>
        )}

        {pushEnabled && (
          <div className="page-actions">
            <button
              type="button"
              className="danger-text-btn"
              onClick={handleDisable}
              onBlur={() => setConfirmDisable(false)}
              disabled={isBusy}
            >
              {confirmDisable ? 'Так, вимкнути сповіщення' : 'Вимкнути сповіщення'}
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
