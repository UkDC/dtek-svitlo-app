import React, { useEffect, useRef, useState } from 'react';
import {
  Bell,
  BellRing,
  CheckCircle2,
  Cloud,
  Copy,
  Moon,
  Send,
  Share2,
  Smartphone,
  X,
} from 'lucide-react';
import { SavedAddress, toSyncAddress } from '../services/scheduleNormalizer';
import {
  GitHubCloudConfig,
  QuietHoursSettings,
  loadGitHubCloudConfig,
  registerAndSubscribePush,
  saveGitHubCloudConfig,
  syncSubscriberState,
  triggerTestNotification,
} from '../services/pushSyncService';

interface NotificationSettingsModalProps {
  addresses: SavedAddress[];
  quietHours: QuietHoursSettings;
  pushEnabled: boolean;
  onUpdateQuietHours: (next: QuietHoursSettings) => void;
  onPushStatusChange: (enabled: boolean) => void;
  onClose: () => void;
}

export const NotificationSettingsModal: React.FC<
  NotificationSettingsModalProps
> = ({
  addresses,
  quietHours,
  pushEnabled,
  onUpdateQuietHours,
  onPushStatusChange,
  onClose,
}) => {
  const [statusMessage, setStatusMessage] = useState<string>('');
  const [isBusy, setIsBusy] = useState(false);
  const [tokenPayload, setTokenPayload] = useState<string>('');
  const [copied, setCopied] = useState<boolean>(false);
  const tokenTextareaRef = useRef<HTMLTextAreaElement>(null);

  const initialGh = loadGitHubCloudConfig();
  const [ghRepo, setGhRepo] = useState(initialGh.repoFullName);
  const [ghToken, setGhToken] = useState(initialGh.token);
  const [showCloudSetup, setShowCloudSetup] = useState(false);

  // Auto-detect existing push subscription and populate token box immediately
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => {
        if (sub) {
          const payload = JSON.stringify(
            {
              id: `ios_${Date.now()}`,
              subscription: sub.toJSON(),
              addresses: addresses.map(toSyncAddress),
              quietHours,
              updatedAt: new Date().toISOString(),
            },
            null,
            2
          );
          setTokenPayload(payload);
        }
      })
      .catch(() => {});
  }, [addresses, quietHours]);

  const handleEnablePush = async () => {
    setIsBusy(true);
    setStatusMessage('Подключаем системные уведомления iOS…');
    try {
      const res = await registerAndSubscribePush();
      if (!res.ok) {
        setStatusMessage(res.error || 'Не удалось включить уведомления.');
        setIsBusy(false);
        return;
      }

      onPushStatusChange(true);
      await syncSubscriberState(addresses, quietHours, res.subscription);
      setStatusMessage(
        'Push-уведомления успешно активированы и синхронизированы!'
      );
    } finally {
      setIsBusy(false);
    }
  };

  const handleTestPush = async () => {
    setIsBusy(true);
    setStatusMessage('Отправляем проверочное уведомление…');
    try {
      const firstLabel = addresses[0]?.label;
      const result = await triggerTestNotification(firstLabel);
      setStatusMessage(result.message);
    } finally {
      setIsBusy(false);
    }
  };

  const handleCopySubscription = async () => {
    try {
      setIsBusy(true);
      setStatusMessage('Формирование токена iPhone...');
      const res = await registerAndSubscribePush();
      if (!res.ok || !res.subscription) {
        setStatusMessage(res.error || 'Не удалось получить токен. Нажмите «Включить Push-уведомления».');
        return;
      }
      onPushStatusChange(true);
      const payload = JSON.stringify(
        {
          id: `ios_${Date.now()}`,
          subscription: res.subscription.toJSON(),
          addresses: addresses.map(toSyncAddress),
          quietHours,
          updatedAt: new Date().toISOString(),
        },
        null,
        2
      );
      setTokenPayload(payload);
      
      let copySuccess = false;
      try {
        await navigator.clipboard.writeText(payload);
        copySuccess = true;
      } catch {
        // iOS clipboard async restriction handled below
      }

      if (copySuccess) {
        setCopied(true);
        setStatusMessage('Токен скопирован в буфер обмена! Также он показан в поле ниже.');
      } else {
        setStatusMessage('Токен готов! Нажмите зеленую кнопку «Скопировать» или выделите текст в поле ниже.');
      }
    } catch {
      setStatusMessage('Не удалось сформировать токен.');
    } finally {
      setIsBusy(false);
    }
  };

  const handleDirectCopy = () => {
    if (!tokenPayload) return;
    if (tokenTextareaRef.current) {
      tokenTextareaRef.current.focus();
      tokenTextareaRef.current.select();
      tokenTextareaRef.current.setSelectionRange(0, 99999);
    }
    let success = false;
    try {
      navigator.clipboard.writeText(tokenPayload);
      success = true;
    } catch {}
    try {
      if (document.execCommand('copy')) {
        success = true;
      }
    } catch {}
    setCopied(true);
    setStatusMessage('Скопировано в буфер обмена!');
  };

  const handleShare = async () => {
    if (!tokenPayload) return;
    if (navigator.share) {
      try {
        await navigator.share({
          title: 'Svitlo Push Token',
          text: tokenPayload,
        });
      } catch {
        handleDirectCopy();
      }
    } else {
      handleDirectCopy();
    }
  };

  const handleSaveCloudSync = async () => {
    const cfg: GitHubCloudConfig = {
      repoFullName: ghRepo.trim(),
      token: ghToken.trim(),
    };
    saveGitHubCloudConfig(cfg);
    setIsBusy(true);
    const res = await syncSubscriberState(addresses, quietHours);
    setIsBusy(false);
    if (res.syncedGitHub || res.syncedBackend) {
      setStatusMessage('Настройки успешно синхронизированы с облаком GitHub!');
    } else {
      setStatusMessage('Параметры GitHub сохранены в памяти iPhone.');
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2 className="modal-title">Уведомления и iPhone PWA</h2>
          <button type="button" className="close-btn" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        {/* iOS 18.7+ Home Screen & Web Push Card */}
        <div
          style={{
            padding: '14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-strong)',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div
              style={{
                width: 38,
                height: 38,
                borderRadius: 11,
                background: 'var(--status-on-bg)',
                color: 'var(--status-on)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              {pushEnabled ? <BellRing size={20} /> : <Bell size={20} />}
            </div>
            <div>
              <div style={{ fontWeight: 700, fontSize: '14.5px' }}>
                {pushEnabled
                  ? 'Push-уведомления активны'
                  : 'Подключение уведомлений iOS 18.7+'}
              </div>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                За 30 мин до отключения • За 30 мин до включения • При смене
                графика
              </div>
              <div style={{ fontSize: '11.5px', marginTop: '3px' }}>
                {typeof Notification === 'undefined' ? (
                  <span style={{ color: 'var(--status-maybe)' }}>
                    ⚠️ Добавьте приложение на экран «Домой» для работы Push
                  </span>
                ) : Notification.permission === 'granted' ? (
                  <span style={{ color: 'var(--status-on)' }}>
                    ✅ Доступ к уведомлениям iOS разрешён
                  </span>
                ) : Notification.permission === 'denied' ? (
                  <span style={{ color: 'var(--status-off)' }}>
                    ❌ Уведомления заблокированы (Параметры iOS → Safari → Уведомления)
                  </span>
                ) : (
                  <span style={{ color: 'var(--status-maybe)' }}>
                    ⚠️ Разрешение ещё не запрошено (нажмите кнопку ниже)
                  </span>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            className="primary-btn"
            onClick={handleEnablePush}
            disabled={isBusy}
          >
            <CheckCircle2 size={17} />
            <span>
              {pushEnabled
                ? 'Обновить подписку на уведомления'
                : 'Включить Push-уведомления'}
            </span>
          </button>

          <button
            type="button"
            className="secondary-btn"
            onClick={handleTestPush}
            disabled={isBusy}
          >
            <Send size={15} />
            <span>Отправить тестовое уведомление</span>
          </button>

          <button
            type="button"
            className="secondary-btn"
            onClick={handleCopySubscription}
            disabled={isBusy}
            style={{ fontSize: '13px' }}
          >
            <Copy size={15} />
            <span>Скопировать токен для экрана блокировки</span>
          </button>
        </div>

        {tokenPayload && (
          <div
            style={{
              padding: '12px',
              background: 'var(--bg-elevated)',
              border: '1px solid var(--border-subtle)',
              borderRadius: 'var(--radius-md)',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
              }}
            >
              <span
                style={{
                  fontSize: '13px',
                  fontWeight: 600,
                  color: 'var(--text-main)',
                }}
              >
                Токен iPhone
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                {typeof navigator !== 'undefined' && 'share' in navigator && (
                  <button
                    type="button"
                    className="secondary-btn"
                    onClick={handleShare}
                    style={{ fontSize: '12px', padding: '5px 10px' }}
                  >
                    <Share2 size={13} />
                    <span>Поделиться</span>
                  </button>
                )}
                <button
                  type="button"
                  className="primary-btn"
                  onClick={handleDirectCopy}
                  style={{ fontSize: '12px', padding: '5px 12px' }}
                >
                  {copied ? <CheckCircle2 size={13} /> : <Copy size={13} />}
                  <span>{copied ? 'Скопировано!' : 'Скопировать'}</span>
                </button>
              </div>
            </div>

            <textarea
              ref={tokenTextareaRef}
              readOnly
              value={tokenPayload}
              onClick={(e) => (e.target as HTMLTextAreaElement).select()}
              style={{
                width: '100%',
                height: '110px',
                fontFamily: 'var(--font-mono)',
                fontSize: '11px',
                padding: '8px',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-main)',
                resize: 'none',
              }}
            />
            <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
              Нажмите зеленую кнопку «Скопировать» или выделите текст в поле и вставьте в чат.
            </span>
          </div>
        )}

        {statusMessage && <div className="status-toast">{statusMessage}</div>}

        {/* Quiet Hours (Тихие ночные часы) */}
        <div className="form-group">
          <label className="form-label">
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <Moon size={14} /> Тихие ночные часы (Защита сна)
            </span>
          </label>

          <div className="toggle-row">
            <div className="toggle-info">
              <span className="toggle-title">Не беспокоить ночью</span>
              <span className="toggle-desc">
                Без звуковых пушей с {quietHours.start} до {quietHours.end}
              </span>
            </div>
            <button
              type="button"
              className={`ios-switch ${quietHours.enabled ? 'checked' : ''}`}
              onClick={() =>
                onUpdateQuietHours({
                  ...quietHours,
                  enabled: !quietHours.enabled,
                })
              }
            >
              <span className="ios-switch-thumb" />
            </button>
          </div>

          {quietHours.enabled && (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '8px',
                marginTop: '4px',
              }}
            >
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>
                  Начало тишины
                </label>
                <input
                  type="time"
                  className="text-input"
                  value={quietHours.start}
                  onChange={(e) =>
                    onUpdateQuietHours({ ...quietHours, start: e.target.value })
                  }
                />
              </div>
              <div>
                <label className="form-label" style={{ marginBottom: 4 }}>
                  Конец тишины
                </label>
                <input
                  type="time"
                  className="text-input"
                  value={quietHours.end}
                  onChange={(e) =>
                    onUpdateQuietHours({ ...quietHours, end: e.target.value })
                  }
                />
              </div>
            </div>
          )}
        </div>

        {/* iOS 18.7+ Installation Tip */}
        <div
          style={{
            padding: '12px 14px',
            borderRadius: 'var(--radius-md)',
            background: 'var(--bg-card)',
            border: '1px solid var(--border-subtle)',
            fontSize: '12.5px',
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
          }}
        >
          <div
            style={{
              fontWeight: 700,
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            <Smartphone size={15} style={{ color: 'var(--accent-primary)' }} />
            <span>Как добавить на экран «Домой» в iOS 18.7+:</span>
          </div>
          <ol style={{ paddingLeft: '18px', color: 'var(--text-secondary)', display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <li>
              Откройте приложение в <strong>Safari</strong> на iPhone.
            </li>
            <li>
              Нажмите кнопку <strong>«Поделиться»</strong> (квадрат со стрелкой
              вверх внизу экрана).
            </li>
            <li>
              Выберите <strong>«На экран „Домой“» (Add to Home Screen)</strong> и
              нажмите «Добавить».
            </li>
          </ol>
        </div>

        {/* Optional GitHub Cloud Worker Sync */}
        <div className="form-group">
          <button
            type="button"
            className="secondary-btn"
            onClick={() => setShowCloudSetup(!showCloudSetup)}
          >
            <Cloud size={15} />
            <span>
              {showCloudSetup
                ? 'Скрыть настройки GitHub Cloud Sync'
                : 'Синхронизация с GitHub Actions (Облачный Push)'}
            </span>
          </button>

          {showCloudSetup && (
            <div
              style={{
                padding: '12px',
                borderRadius: 'var(--radius-md)',
                background: 'var(--bg-card)',
                border: '1px solid var(--border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: '10px',
                marginTop: '6px',
              }}
            >
              <div style={{ fontSize: '11.5px', color: 'var(--text-secondary)' }}>
                При работе со статического GitHub Pages укажите репозиторий и
                Fine-Grained PAT (хранится исключительно в памяти вашего iPhone),
                чтобы воркер GitHub Actions знал ваши адреса и присылал Web Push:
              </div>
              <input
                type="text"
                className="text-input"
                placeholder="owner/dtek-svitlo-app"
                value={ghRepo}
                onChange={(e) => setGhRepo(e.target.value)}
              />
              <input
                type="password"
                className="text-input"
                placeholder="github_pat_... (только локально на iPhone)"
                value={ghToken}
                onChange={(e) => setGhToken(e.target.value)}
              />
              <button
                type="button"
                className="primary-btn"
                onClick={handleSaveCloudSync}
                disabled={isBusy}
              >
                Сохранить и синхронизировать с GitHub
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
