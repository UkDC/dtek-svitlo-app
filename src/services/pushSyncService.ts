import { SavedAddress, toSyncAddress } from './scheduleNormalizer';

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
}

export interface GitHubCloudConfig {
  repoFullName: string; // e.g., "username/dtek-svitlo-app"
  token: string; // Fine-grained PAT stored ONLY in iPhone localStorage
}

const DEVICE_ID_KEY = 'svitlo_device_subscriber_id';
const GH_CONFIG_KEY = 'svitlo_gh_cloud_config_v1';

export function getDeviceSubscriberId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = `ios_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

export function loadGitHubCloudConfig(): GitHubCloudConfig {
  try {
    // Support one-time URL hash provisioning: #gh_repo=owner/repo&gh_token=github_pat_...
    if (window.location.hash.includes('gh_token=')) {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const hashToken = params.get('gh_token');
      const hashRepo = params.get('gh_repo');
      if (hashToken) {
        const existing = JSON.parse(localStorage.getItem(GH_CONFIG_KEY) || '{}');
        const nextConfig: GitHubCloudConfig = {
          repoFullName: hashRepo || existing.repoFullName || detectRepoFromLocation(),
          token: hashToken,
        };
        localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(nextConfig));
        window.history.replaceState(
          null,
          '',
          window.location.pathname + window.location.search
        );
        return nextConfig;
      }
    }

    const raw = localStorage.getItem(GH_CONFIG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        repoFullName: parsed.repoFullName || detectRepoFromLocation(),
        token: parsed.token || '',
      };
    }
  } catch {
    // ignore
  }
  return {
    repoFullName: detectRepoFromLocation(),
    token: '',
  };
}

export function saveGitHubCloudConfig(cfg: GitHubCloudConfig): void {
  localStorage.setItem(GH_CONFIG_KEY, JSON.stringify(cfg));
}

function detectRepoFromLocation(): string {
  const host = window.location.hostname;
  if (host.endsWith('.github.io')) {
    const owner = host.replace('.github.io', '');
    const pathSeg = window.location.pathname.split('/').filter(Boolean)[0];
    if (owner && pathSeg) {
      return `${owner}/${pathSeg}`;
    }
  }
  return '';
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const apiRes = await fetch('./api/push/vapid-public-key', {
      signal: AbortSignal.timeout(3000),
    });
    if (apiRes.ok) {
      const data = await apiRes.json();
      if (data?.publicKey) return data.publicKey;
    }
  } catch {
    // Fallback to static state file on GitHub Pages
  }

  try {
    const staticRes = await fetch(`./state/vapid-public.json?t=${Date.now()}`);
    if (staticRes.ok) {
      const data = await staticRes.json();
      if (data?.publicKey) return data.publicKey;
    }
  } catch {
    // ignore
  }
  return null;
}

export async function registerAndSubscribePush(): Promise<{
  ok: boolean;
  subscription: PushSubscription | null;
  error?: string;
}> {
  if (!('serviceWorker' in navigator)) {
    return {
      ok: false,
      subscription: null,
      error: 'Service Worker не поддерживается в текущем режиме браузера.',
    };
  }

  if (!('Notification' in window)) {
    return {
      ok: false,
      subscription: null,
      error:
        'Для включения Push на iPhone добавьте приложение на экран «Домой» (Поделиться → На экран «Домой»).',
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      subscription: null,
      error: 'Разрешение на уведомления отклонено в настройках iOS.',
    };
  }

  const reg = await navigator.serviceWorker.ready;

  const publicKey = await fetchVapidPublicKey();
  let sub = await reg.pushManager.getSubscription();

  if (sub && publicKey) {
    try {
      const currentKeyBytes = urlBase64ToUint8Array(publicKey);
      const subKeyBytes = sub.options?.applicationServerKey
        ? new Uint8Array(sub.options.applicationServerKey)
        : null;
      const isMatching =
        subKeyBytes &&
        subKeyBytes.length === currentKeyBytes.length &&
        subKeyBytes.every((val, i) => val === currentKeyBytes[i]);

      if (!isMatching) {
        console.log('[Push] Application server key mismatch. Renewing subscription...');
        await sub.unsubscribe();
        sub = null;
      }
    } catch {
      // ignore
    }
  }

  if (!sub && publicKey && reg.pushManager) {
    try {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as unknown as BufferSource,
      });
    } catch {
      return {
        ok: true,
        subscription: null,
      };
    }
  }

  return {
    ok: true,
    subscription: sub,
  };
}

/**
 * Syncs saved addresses & notification settings to Backend API and/or GitHub repository state
 */
export async function syncSubscriberState(
  addresses: SavedAddress[],
  quietHours: QuietHoursSettings,
  subscription?: PushSubscription | null
): Promise<{ syncedBackend: boolean; syncedGitHub: boolean }> {
  const id = getDeviceSubscriberId();
  let subJson: any = subscription ? subscription.toJSON() : null;

  if (!subJson && 'serviceWorker' in navigator) {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const existingSub = await reg?.pushManager?.getSubscription();
      if (existingSub) subJson = existingSub.toJSON();
    } catch {
      // ignore
    }
  }

  const profilePayload = {
    id,
    subscription: subJson,
    // street / house / city never leave the device: the target repo is public
    addresses: addresses.map(toSyncAddress),
    quietHours,
    updatedAt: new Date().toISOString(),
  };

  let syncedBackend = false;
  let syncedGitHub = false;

  // 1. Try syncing with Backend Server API
  try {
    const res = await fetch('./api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(profilePayload),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      syncedBackend = true;
    }
  } catch {
    // Backend not active (e.g. pure GitHub Pages)
  }

  // 2. If GitHub Cloud Sync token is configured on iPhone, sync directly to repo state/subscriptions.json
  const ghCfg = loadGitHubCloudConfig();
  if (ghCfg.repoFullName && ghCfg.token) {
    try {
      const apiUrl = `https://api.github.com/repos/${ghCfg.repoFullName}/contents/state/subscriptions.json`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${ghCfg.token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      };

      let existingSha: string | undefined;
      let existingList: any[] = [];

      const getRes = await fetch(apiUrl, { headers });
      if (getRes.ok) {
        const fileData = await getRes.json();
        existingSha = fileData.sha;
        if (fileData.content) {
          const decoded = new TextDecoder().decode(
            Uint8Array.from(atob(fileData.content.replace(/\n/g, '')), (c) =>
              c.charCodeAt(0)
            )
          );
          const parsed = JSON.parse(decoded);
          if (Array.isArray(parsed)) existingList = parsed;
        }
      }

      const idx = existingList.findIndex((item) => item.id === id);
      if (idx >= 0) {
        existingList[idx] = profilePayload;
      } else {
        existingList.push(profilePayload);
      }

      const jsonStr = JSON.stringify(existingList, null, 2);
      const base64Content = btoa(
        Array.from(new TextEncoder().encode(jsonStr), (b) =>
          String.fromCharCode(b)
        ).join('')
      );

      const putRes = await fetch(apiUrl, {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          message: `chore(sync): update iPhone subscriber ${id}`,
          content: base64Content,
          ...(existingSha ? { sha: existingSha } : {}),
        }),
      });

      if (putRes.ok) {
        syncedGitHub = true;
      }
    } catch {
      // ignore
    }
  }

  return { syncedBackend, syncedGitHub };
}

/**
 * Triggers an immediate test notification (both via local Service Worker & remote Web Push / GitHub Actions)
 */
export async function triggerTestNotification(
  addressLabel?: string
): Promise<{ ok: boolean; message: string }> {
  let localShown = false;

  if ('serviceWorker' in navigator && 'Notification' in window) {
    if (Notification.permission === 'granted') {
      try {
        const reg = await navigator.serviceWorker.ready;
        const cleanStreet = (addressLabel || 'вул. Хрещатик')
          .replace(/^вул\.\s*/i, '')
          .trim();
        const shortAddr = cleanStreet.split(' ')[0] || cleanStreet;

        await reg.showNotification(`🟢 Увімкнення за 30 хв • вул. ${shortAddr}`, {
          body: 'Світло буде: 16:30 – 20:00 (3.5 год)',
          icon: './icon-on.svg',
          badge: './icon-on.svg',
          tag: 'svitlo-test-on',
        });
        localShown = true;
      } catch {
        // fallback below
      }
    }
  }

  // Also trigger backend Web Push if connected
  try {
    let subJson: any = null;
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager?.getSubscription();
      if (sub) subJson = sub.toJSON();
    }

    const res = await fetch('./api/push/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subJson, addressLabel }),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) {
      return {
        ok: true,
        message: 'Тестовое Push-уведомление успешно отправлено на ваш iPhone!',
      };
    }
  } catch {
    // Try triggering GitHub Actions workflow_dispatch if configured
  }

  const ghCfg = loadGitHubCloudConfig();
  if (ghCfg.repoFullName && ghCfg.token) {
    try {
      const dispatchUrl = `https://api.github.com/repos/${ghCfg.repoFullName}/actions/workflows/push-check.yml/dispatches`;
      const dispRes = await fetch(dispatchUrl, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ghCfg.token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { test_push: 'true' },
        }),
      });
      if (dispRes.ok) {
        return {
          ok: true,
          message:
            'Локальный пуш показан + запущена отправка облачного Apple Web Push через GitHub Actions!',
        };
      }
    } catch {
      // ignore
    }
  }

  if (localShown) {
    return {
      ok: true,
      message: 'Тестовое уведомление отображено на устройстве!',
    };
  }

  return {
    ok: false,
    message:
      'Сначала разрешите уведомления (на iPhone приложение должно быть добавлено на экран «Домой»).',
  };
}
