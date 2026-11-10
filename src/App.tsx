import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, CheckCircle2, ChevronDown, Sparkles, X, ZapOff } from 'lucide-react';
import {
  GroupSchedule,
  SavedAddress,
  UpcomingAlertTrigger,
  computeScheduleDiff,
  evaluateUpcomingAlerts,
  getKyivTimeContext,
  isWithinQuietHours,
  rolloverGroupSchedule,
} from './services/scheduleNormalizer';
import {
  RegionSchedulesBundle,
  fetchAllSchedules,
  loadCachedSchedules,
} from './services/clientScheduleApi';
import {
  QuietHoursSettings,
  hasPushSubscription,
  loadInviteCode,
  purgeLegacyGitHubToken,
  syncSubscriberState,
} from './services/pushSyncService';
import { AddressSheet, addressTitle, regionName } from './components/AddressSheet';
import { DayOverview } from './components/DayOverview';
import { EmptyState } from './components/EmptyState';
import { AddressPage } from './components/AddressPage';
import { NotificationsPage, ThemePreference } from './components/NotificationsPage';

const STORAGE_KEY_ADDRESSES = 'svitlo_saved_addresses_v1';
const STORAGE_KEY_SELECTED = 'svitlo_selected_address_id_v1';
const STORAGE_KEY_QUIET = 'svitlo_quiet_hours_v1';
// v2: the old key stored 'dark' for everyone (it was the default); the new default follows the system
const STORAGE_KEY_THEME = 'svitlo_theme_v2';
const CURRENT_BUILD_TIMESTAMP = '2026-11-10T06:45:00Z';

export const App: React.FC = () => {
  const [addresses, setAddresses] = useState<SavedAddress[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_ADDRESSES);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed as SavedAddress[];
      }
    } catch {
      // ignore corrupted storage
    }
    return [];
  });

  const [selectedId, setSelectedId] = useState<string>(() => {
    return localStorage.getItem(STORAGE_KEY_SELECTED) || '';
  });

  const [quietHours, setQuietHours] = useState<QuietHoursSettings>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY_QUIET);
      if (raw) return JSON.parse(raw);
    } catch {
      // ignore
    }
    return { enabled: true, start: '23:00', end: '07:00' };
  });

  const [bundle, setBundle] = useState<RegionSchedulesBundle | null>(() =>
    loadCachedSchedules()
  );
  const [isRefreshing, setIsRefreshing] = useState<boolean>(false);
  const [kyivClock, setKyivClock] = useState(() => getKyivTimeContext());
  const [intradayDiffByGroup, setIntradayDiffByGroup] = useState<
    Record<string, string>
  >({});
  const [hasUpdateAvailable, setHasUpdateAvailable] = useState<boolean>(false);

  // Modals state
  const [isAddressModalOpen, setIsAddressModalOpen] = useState(() => addresses.length === 0);
  const [editingAddress, setEditingAddress] = useState<SavedAddress | null>(null);
  const [isNotificationsModalOpen, setIsNotificationsModalOpen] = useState(false);
  const [isSheetOpen, setIsSheetOpen] = useState(false);
  // «On» means: the OS permission is granted AND this device holds a push subscription.
  // (Turning notifications off keeps the OS permission granted, so permission alone is not enough.)
  const [pushEnabled, setPushEnabled] = useState<boolean>(false);
  const [themePref, setThemePref] = useState<ThemePreference>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY_THEME);
      return saved === 'light' || saved === 'dark' ? saved : 'system';
    } catch {
      return 'system';
    }
  });

  const [notifiedEvents, setNotifiedEvents] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem('svitlo_notified_events');
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  });

  const [activeAlertBanner, setActiveAlertBanner] = useState<UpcomingAlertTrigger | null>(null);

  // Theme follows the system (prefers-color-scheme); an explicit 'light' | 'dark' override is optional
  useEffect(() => {
    try {
      if (themePref === 'system') {
        localStorage.removeItem(STORAGE_KEY_THEME);
      } else {
        localStorage.setItem(STORAGE_KEY_THEME, themePref);
      }
    } catch {
      // storage unavailable: the attribute below still applies for this session
    }
    if (themePref === 'system') {
      document.documentElement.removeAttribute('data-theme');
    } else {
      document.documentElement.setAttribute('data-theme', themePref);
    }
  }, [themePref]);

  // Reflect the real push state (permission + subscription) on mount
  useEffect(() => {
    let cancelled = false;
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    hasPushSubscription()
      .then((has) => {
        if (!cancelled) setPushEnabled(has);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // Older builds kept a repo-write GitHub token on the phone; it is unused now, so drop it
  useEffect(() => {
    purgeLegacyGitHubToken();
    loadInviteCode(); // also picks up a #invite=… link
  }, []);

  // Persist addresses
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_ADDRESSES, JSON.stringify(addresses));
    syncSubscriberState(addresses, quietHours).catch(() => {});
  }, [addresses, quietHours]);

  // Persist selected address
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_SELECTED, selectedId);
  }, [selectedId]);

  // Persist quiet hours
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY_QUIET, JSON.stringify(quietHours));
  }, [quietHours]);

  // Update Kyiv clock every 30 seconds
  useEffect(() => {
    const interval = setInterval(() => {
      setKyivClock(getKyivTimeContext());
    }, 30_000);
    return () => clearInterval(interval);
  }, []);

  const refreshSchedules = useCallback(
    async (force = false) => {
      setIsRefreshing(true);
      try {
        const nextBundle = await fetchAllSchedules(force);
        setBundle((prevBundle) => {
          if (prevBundle) {
            const nextDiffs: Record<string, string> = {};
            for (const [grp, nextSched] of Object.entries(nextBundle.kem)) {
              const prevSched = prevBundle.kem[grp];
              if (prevSched) {
                const diff = computeScheduleDiff(
                  prevSched.today,
                  nextSched.today,
                  'Сьогодні'
                );
                if (diff.hasChanged) {
                  nextDiffs[`kem:${grp}`] = diff.summaryText;
                }
              }
            }
            for (const [grp, nextSched] of Object.entries(nextBundle.krem)) {
              const prevSched = prevBundle.krem[grp];
              if (prevSched) {
                const diff = computeScheduleDiff(
                  prevSched.today,
                  nextSched.today,
                  'Сьогодні'
                );
                if (diff.hasChanged) {
                  nextDiffs[`krem:${grp}`] = diff.summaryText;
                }
              }
            }
            if (Object.keys(nextDiffs).length > 0) {
              setIntradayDiffByGroup((old) => ({ ...old, ...nextDiffs }));
            }
          }
          return nextBundle;
        });
      } finally {
        setIsRefreshing(false);
      }
    },
    []
  );

  // Check for upcoming 30-minute outage and power restoration alerts
  const checkUpcomingAlerts = useCallback(() => {
    if (!bundle) return;
    const nowMin = kyivClock.nowMinutes;
    const inQuiet = isWithinQuietHours(
      nowMin,
      quietHours.enabled,
      quietHours.start,
      quietHours.end
    );

    for (const addr of addresses) {
      const scheduleMap = addr.region === 'kem' ? bundle.kem : bundle.krem;
      const rawGroupSched = scheduleMap[addr.group];
      if (!rawGroupSched?.today) continue;
      const groupSched = rolloverGroupSchedule(
        rawGroupSched,
        kyivClock.todayDateKey,
        kyivClock.tomorrowDateKey
      );

      const triggers = evaluateUpcomingAlerts(
        addr,
        groupSched.today,
        nowMin,
        notifiedEvents,
        10,
        42,
        groupSched.tomorrow
      );

      if (triggers.length > 0) {
        const trigger = triggers[0];
        const nextNotified = {
          ...notifiedEvents,
          [trigger.eventId]: new Date().toISOString(),
        };
        setNotifiedEvents(nextNotified);
        try {
          localStorage.setItem(
            'svitlo_notified_events',
            JSON.stringify(nextNotified)
          );
        } catch {}

        if (!inQuiet) {
          setActiveAlertBanner(trigger);

          // Native Web Notification via Service Worker
          if (
            typeof Notification !== 'undefined' &&
            Notification.permission === 'granted' &&
            'serviceWorker' in navigator
          ) {
            navigator.serviceWorker.ready
              .then((reg) => {
                // `renotify` is valid at runtime but missing from lib.dom's NotificationOptions
                const options: NotificationOptions & { renotify?: boolean } = {
                  body: trigger.body,
                  icon: './icon-192.svg',
                  badge: './icon-192.svg',
                  tag: trigger.eventId,
                  renotify: true,
                  data: { url: './', addressId: trigger.addressId },
                };
                reg.showNotification(trigger.title, options);
              })
              .catch(() => {});
          }

          // Haptic feedback
          if ('vibrate' in navigator) {
            try {
              navigator.vibrate([200, 100, 200]);
            } catch {}
          }
        }
        break;
      }
    }
  }, [bundle, kyivClock.nowMinutes, kyivClock.todayDateKey, kyivClock.tomorrowDateKey, addresses, quietHours, notifiedEvents]);

  // Run alert check on clock change or bundle update
  useEffect(() => {
    checkUpcomingAlerts();
  }, [checkUpcomingAlerts]);

  // Auto-refresh when user opens, resumes, or returns to the app (e.g. iPhone PWA waking up from sleep)
  useEffect(() => {
    const handleResume = () => {
      setKyivClock(getKyivTimeContext());
      refreshSchedules(true);
      checkUpcomingAlerts();

      // Check Service Worker registration for app update
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.getRegistration().then((reg) => {
          if (reg) reg.update().catch(() => {});
        });
      }

      // Check version.json for new deployment
      fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => {
          if (data?.buildTime && data.buildTime > CURRENT_BUILD_TIMESTAMP) {
            setHasUpdateAvailable(true);
          }
        })
        .catch(() => {});
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        handleResume();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', handleResume);
    window.addEventListener('focus', handleResume);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', handleResume);
      window.removeEventListener('focus', handleResume);
    };
  }, [refreshSchedules]);

  // Initial load + 10-minute background polling
  useEffect(() => {
    refreshSchedules(true);
    const pollInterval = setInterval(() => {
      refreshSchedules(true);
    }, 10 * 60_000);
    return () => clearInterval(pollInterval);
  }, [refreshSchedules]);

  // Ensure selected address exists
  const activeAddress = useMemo<SavedAddress | null>(() => {
    return addresses.find((a) => a.id === selectedId) || addresses[0] || null;
  }, [addresses, selectedId]);

  // Map schedules for all saved addresses
  const schedulesByAddressId = useMemo(() => {
    const map: Record<string, GroupSchedule | undefined> = {};
    if (!bundle) return map;
    for (const addr of addresses) {
      const regionDict = addr.region === 'kem' ? bundle.kem : bundle.krem;
      // Never substitute another group's schedule for a missing one (it would show wrong data as fact).
      const sched = regionDict[addr.group];
      map[addr.id] = sched
        ? rolloverGroupSchedule(sched, kyivClock.todayDateKey, kyivClock.tomorrowDateKey)
        : undefined;
    }
    return map;
  }, [bundle, addresses, kyivClock.todayDateKey, kyivClock.tomorrowDateKey]);

  const activeSchedule = activeAddress ? schedulesByAddressId[activeAddress.id] : undefined;
  const activeDiffKey = activeAddress ? `${activeAddress.region}:${activeAddress.group}` : '';
  const activeIntradayNote = intradayDiffByGroup[activeDiffKey];

  const handleSaveAddress = (saved: SavedAddress) => {
    setAddresses((prev) => {
      const exists = prev.some((a) => a.id === saved.id);
      if (exists) {
        return prev.map((a) => (a.id === saved.id ? saved : a));
      }
      return [...prev, saved];
    });
    setSelectedId(saved.id);
    setIsAddressModalOpen(false);
    setEditingAddress(null);
  };

  const handleUpdateAddress = (id: string, patch: Partial<SavedAddress>) => {
    setAddresses((prev) => prev.map((a) => (a.id === id ? { ...a, ...patch } : a)));
  };

  const handleDeleteAddress = (id: string) => {
    setAddresses((prev) => {
      const next = prev.filter((a) => a.id !== id);
      if (selectedId === id) {
        setSelectedId(next[0]?.id || '');
      }
      return next;
    });
    setIsAddressModalOpen(false);
    setEditingAddress(null);
  };

  const kemGroups = useMemo(
    () =>
      bundle?.kemGroups || [
        '1.1',
        '1.2',
        '2.1',
        '2.2',
        '3.1',
        '3.2',
        '4.1',
        '4.2',
        '5.1',
        '5.2',
        '6.1',
        '6.2',
        '20.1',
      ],
    [bundle]
  );

  const kremGroups = useMemo(
    () =>
      bundle?.kremGroups || [
        '1.1',
        '1.2',
        '2.1',
        '2.2',
        '3.1',
        '3.2',
        '4.1',
        '4.2',
        '5.1',
        '5.2',
        '6.1',
        '6.2',
      ],
    [bundle]
  );

  const openAddAddress = () => {
    setIsSheetOpen(false);
    setEditingAddress(null);
    setIsAddressModalOpen(true);
  };

  const openEditAddress = (addr: SavedAddress) => {
    setIsSheetOpen(false);
    setEditingAddress(addr);
    setIsAddressModalOpen(true);
  };

  return (
    <div className="app-shell">
      {activeAddress && (
        <header className="top-header">
          <button
            type="button"
            className="address-trigger"
            aria-haspopup="dialog"
            onClick={() => setIsSheetOpen(true)}
          >
            <span className="address-trigger-text">
              <span className="address-trigger-name">{addressTitle(activeAddress)}</span>
              <span className="address-trigger-meta">
                ДТЕК {regionName(activeAddress)} · Група {activeAddress.group}
              </span>
            </span>
            <ChevronDown size={18} strokeWidth={2.2} aria-hidden="true" />
          </button>
          <button
            type="button"
            className="round-btn"
            aria-label="Сповіщення"
            onClick={() => setIsNotificationsModalOpen(true)}
          >
            <Bell size={20} aria-hidden="true" />
          </button>
        </header>
      )}

      {hasUpdateAvailable && (
        <div className="note-banner note-banner-action" role="status">
          <Sparkles size={18} aria-hidden="true" />
          <span>Доступне оновлення застосунку</span>
          <button
            type="button"
            className="note-banner-btn"
            onClick={() => {
              if ('caches' in window) {
                caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k))));
              }
              window.location.href = window.location.pathname + '?v=' + Date.now();
            }}
          >
            Оновити
          </button>
        </div>
      )}

      {/* In-app reminder shown when the 10..42 min window before an outage/restoration opens */}
      {activeAlertBanner && (
        <div className={`note-banner note-banner-alert ${activeAlertBanner.type}`} role="alert">
          {activeAlertBanner.type === 'before_off' ? (
            <ZapOff size={18} aria-hidden="true" />
          ) : (
            <CheckCircle2 size={18} aria-hidden="true" />
          )}
          <span className="note-banner-text">
            <b>{activeAlertBanner.title}</b>
            <span>{activeAlertBanner.body}</span>
          </span>
          <button
            type="button"
            className="note-banner-close"
            onClick={() => setActiveAlertBanner(null)}
            aria-label="Закрити сповіщення"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>
      )}

      {activeAddress ? (
        <DayOverview
          key={activeAddress.id}
          schedule={activeSchedule}
          nowMinutes={kyivClock.nowMinutes}
          currentTimeStr={kyivClock.currentTimeStr}
          remindersOn={pushEnabled && activeAddress.notifyBeforeOff}
          intradayChangeNote={activeIntradayNote}
          isRefreshing={isRefreshing}
          onRefresh={() => refreshSchedules(true)}
        />
      ) : (
        <EmptyState onAdd={openAddAddress} />
      )}

      {isSheetOpen && (
        <AddressSheet
          addresses={addresses}
          selectedId={activeAddress?.id ?? ''}
          schedulesByAddressId={schedulesByAddressId}
          nowMinutes={kyivClock.nowMinutes}
          onSelect={(id) => {
            setSelectedId(id);
            setIsSheetOpen(false);
          }}
          onEdit={openEditAddress}
          onAdd={openAddAddress}
          onClose={() => setIsSheetOpen(false)}
        />
      )}

      {isAddressModalOpen && (
        <AddressPage
          initialAddress={editingAddress}
          kemGroups={kemGroups}
          kremGroups={kremGroups}
          onSave={handleSaveAddress}
          onDelete={handleDeleteAddress}
          onClose={() => {
            setIsAddressModalOpen(false);
            setEditingAddress(null);
          }}
        />
      )}

      {isNotificationsModalOpen && (
        <NotificationsPage
          address={activeAddress ?? undefined}
          addresses={addresses}
          quietHours={quietHours}
          pushEnabled={pushEnabled}
          themePref={themePref}
          onUpdateAddress={handleUpdateAddress}
          onThemeChange={setThemePref}
          onUpdateQuietHours={setQuietHours}
          onPushStatusChange={setPushEnabled}
          onClose={() => setIsNotificationsModalOpen(false)}
        />
      )}
    </div>
  );
};
