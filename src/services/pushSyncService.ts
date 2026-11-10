import { SavedAddress, TEST_PUSH_BODY, TEST_PUSH_TITLE, toSyncAddress } from './scheduleNormalizer';

export interface QuietHoursSettings {
  enabled: boolean;
  start: string;
  end: string;
}

/**
 * Private subscription store (Cloudflare Worker + KV, see cloudflare/subs). Push endpoints and keys
 * identify a physical device, so they are never written to the public repository.
 */
export const SUBS_API_URL: string =
  (import.meta as any).env?.VITE_SUBS_API_URL ||
  'https://svitlo-subs.svitlo-b79d27.workers.dev';

const DEVICE_ID_KEY = 'svitlo_device_subscriber_id';
const DEVICE_TOKEN_KEY = 'svitlo_device_write_token';
const INVITE_KEY = 'svitlo_invite_code';
const LEGACY_GH_CONFIG_KEY = 'svitlo_gh_cloud_config_v1';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage may be unavailable (private mode)
  }
}

export function getDeviceSubscriberId(): string {
  let id = storageGet(DEVICE_ID_KEY);
  if (!id) {
    id = `ios_${crypto.randomUUID().replace(/-/g, '')}`; // unguessable, unlike the old timestamp ids
    storageSet(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Invitation code of the person who may register devices. Can be provisioned by a link such as
 * https://…/dtek-svitlo-app/#invite=XXXX-XXXX-XXXX-XXXX (the hash never reaches any server).
 */
export function loadInviteCode(): string {
  try {
    if (window.location.hash.includes('invite=')) {
      const code = new URLSearchParams(window.location.hash.slice(1)).get('invite');
      if (code) {
        storageSet(INVITE_KEY, code.trim());
        window.history.replaceState(null, '', window.location.pathname + window.location.search);
      }
    }
  } catch {
    // ignore
  }
  return storageGet(INVITE_KEY) || '';
}

export function saveInviteCode(code: string): void {
  storageSet(INVITE_KEY, code.trim() || null);
}

/**
 * Older builds kept a GitHub token with write access to the repository on the phone. It is no
 * longer used for anything, so it is removed on sight.
 */
export function purgeLegacyGitHubToken(): boolean {
  const had = storageGet(LEGACY_GH_CONFIG_KEY) !== null;
  storageSet(LEGACY_GH_CONFIG_KEY, null);
  return had;
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
      error: 'Service Worker не підтримується в цьому режимі браузера.',
    };
  }

  if (!('Notification' in window)) {
    return {
      ok: false,
      subscription: null,
      error:
        'Щоб увімкнути сповіщення на iPhone, додайте застосунок на екран «Додому» (Поділитися → На екран «Додому»).',
    };
  }

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    return {
      ok: false,
      subscription: null,
      error: 'Дозвіл на сповіщення відхилено в налаштуваннях iOS.',
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

export type CloudSyncError = 'no-invite' | 'invite' | 'invalid' | 'network';

/**
 * Syncs saved addresses & notification settings to the Backend API (dev server) and/or the private
 * Cloudflare subscription store. Street / house / city never leave the device.
 */
export async function syncSubscriberState(
  addresses: SavedAddress[],
  quietHours: QuietHoursSettings,
  subscription?: PushSubscription | null
): Promise<{ syncedBackend: boolean; syncedCloud: boolean; cloudError?: CloudSyncError }> {
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

  const buildPayload = () => ({
    id: getDeviceSubscriberId(),
    subscription: subJson,
    addresses: addresses.map(toSyncAddress),
    quietHours,
    updatedAt: new Date().toISOString(),
  });

  let syncedBackend = false;
  // 1. Local Express dev server (absent on GitHub Pages)
  try {
    const res = await fetch('./api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
      signal: AbortSignal.timeout(4000),
    });
    if (res.ok) syncedBackend = true;
  } catch {
    // Backend not active (e.g. pure GitHub Pages)
  }

  // 2. Private subscription store
  if (!subJson?.endpoint) return { syncedBackend, syncedCloud: false };
  const invite = loadInviteCode();
  if (!invite) return { syncedBackend, syncedCloud: false, cloudError: 'no-invite' };

  const send = async (): Promise<Response | null> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Invite': invite,
    };
    const token = storageGet(DEVICE_TOKEN_KEY);
    if (token) headers['X-Device-Token'] = token;
    try {
      return await fetch(`${SUBS_API_URL}/subscribe`, {
        method: 'POST',
        headers,
        body: JSON.stringify(buildPayload()),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      return null;
    }
  };

  let res = await send();
  if (res && res.status === 403) {
    // the write token for this id was lost or is stale: start over with a fresh device id
    // (the store keeps a single record per push endpoint, so the old record is replaced)
    storageSet(DEVICE_ID_KEY, null);
    storageSet(DEVICE_TOKEN_KEY, null);
    res = await send();
  }
  if (!res) return { syncedBackend, syncedCloud: false, cloudError: 'network' };
  if (res.status === 401) return { syncedBackend, syncedCloud: false, cloudError: 'invite' };
  if (!res.ok) return { syncedBackend, syncedCloud: false, cloudError: 'invalid' };
  try {
    const body = await res.json();
    if (typeof body?.token === 'string') storageSet(DEVICE_TOKEN_KEY, body.token);
  } catch {
    // ignore
  }
  return { syncedBackend, syncedCloud: true };
}

/**
 * Throws away this device's push subscription and creates a fresh one. The previous endpoint stops
 * working, which is the way to retire an endpoint that was ever exposed.
 */
export async function renewPushSubscription(): Promise<{
  ok: boolean;
  subscription: PushSubscription | null;
  error?: string;
}> {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const old = await reg?.pushManager?.getSubscription();
    if (old) await old.unsubscribe();
  } catch {
    // continue: a new subscription is created below anyway
  }
  return registerAndSubscribePush();
}

/** True when this device currently holds a Web Push subscription (permission alone is not enough). */
export async function hasPushSubscription(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager?.getSubscription());
  } catch {
    return false;
  }
}

/**
 * Turns notifications off for this device: removes the record from the private store (when the
 * device is registered there) and drops the local push subscription. The OS permission stays
 * granted, so enabling again later needs no new prompt.
 */
export async function disablePush(): Promise<{ ok: boolean; cloudRemoved: boolean }> {
  const invite = loadInviteCode();
  const token = storageGet(DEVICE_TOKEN_KEY);
  let cloudRemoved = false;
  if (invite && token) {
    try {
      const res = await fetch(`${SUBS_API_URL}/unsubscribe`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Invite': invite,
          'X-Device-Token': token,
        },
        body: JSON.stringify({ id: getDeviceSubscriberId() }),
        signal: AbortSignal.timeout(8000),
      });
      cloudRemoved = res.ok;
    } catch {
      // the local subscription is dropped below anyway; a dead endpoint is pruned server-side
    }
  }

  let localRemoved = true;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    if (sub) localRemoved = await sub.unsubscribe();
  } catch {
    localRemoved = false;
  }
  if (cloudRemoved) {
    storageSet(DEVICE_TOKEN_KEY, null);
    storageSet(DEVICE_ID_KEY, null);
  }
  return { ok: localRemoved, cloudRemoved };
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
        await reg.showNotification(TEST_PUSH_TITLE, {
          body: TEST_PUSH_BODY,
          icon: './icon-192.svg',
          badge: './icon-192.svg',
          tag: 'svitlo-test',
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
        message: 'Тестове сповіщення надіслано на ваш iPhone.',
      };
    }
  } catch {
    // no dev backend: the local notification above is the only test
  }

  if (localShown) {
    return {
      ok: true,
      message:
        'Локальне сповіщення показано. Доставку через хмару звідси перевірити не можна: справжні сповіщення приходять за розкладом.',
    };
  }

  return {
    ok: false,
    message:
      'Спочатку дозвольте сповіщення (на iPhone застосунок має бути додано на екран «Додому»).',
  };
}
