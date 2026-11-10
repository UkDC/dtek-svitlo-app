import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import {
  DaySchedule,
  SavedAddress,
  computeScheduleDiff,
  evaluateUpcomingAlerts,
  buildChangeNotification,
  ScheduleChange,
  TEST_PUSH_TITLE,
  TEST_PUSH_BODY,
  getKyivTimeContext,
  getShortAddress,
  isWithinQuietHours,
} from '../../src/services/scheduleNormalizer.ts';
import { fetchMultiSourceSchedules } from './multiSourceClient.ts';

export interface QuietHoursConfig {
  enabled: boolean;
  start: string; // "23:00"
  end: string; // "07:00"
}

export interface SubscriberProfile {
  id: string;
  subscription: webpush.PushSubscription | null;
  addresses: SavedAddress[];
  quietHours: QuietHoursConfig;
  updatedAt: string;
}

export interface ScheduleSnapshotFile {
  updatedAt: string;
  groups: Record<
    string,
    {
      today: DaySchedule;
      tomorrow: DaySchedule;
    }
  >; // key: "kem:20.1" or "krem:3.1"
  notifiedEvents: Record<string, string>; // eventId -> ISO timestamp
  recentChanges: Array<{
    id: string;
    groupKey: string;
    region: 'kem' | 'krem';
    group: string;
    dayLabel: 'Сьогодні' | 'Завтра';
    summaryText: string;
    detectedAt: string;
  }>;
}

const STATE_DIR = path.resolve(process.cwd(), 'state');
const VAPID_FILE = path.join(STATE_DIR, 'vapid-keys.json');
const SUBSCRIPTIONS_FILE = path.join(STATE_DIR, 'subscriptions.json');
const SNAPSHOT_FILE = path.join(STATE_DIR, 'schedule-snapshot.json');

export function ensureStateDir(): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function getOrGenerateVapidKeys(): {
  publicKey: string;
  privateKey: string;
} {
  ensureStateDir();
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
    };
  }

  // In CI / production the keys MUST come from secrets. There is deliberately no built-in fallback:
  // this repository is public, so any key committed to it is compromised.
  if (process.env.GITHUB_ACTIONS === 'true' || process.env.NODE_ENV === 'production') {
    throw new Error(
      'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set (configure them as repository secrets).'
    );
  }

  // Local development only: generate a throw-away pair into the git-ignored state/vapid-keys.json
  if (fs.existsSync(VAPID_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf-8'));
      if (parsed.publicKey && parsed.privateKey) {
        return parsed;
      }
    } catch {
      // regenerate below
    }
  }

  const generated = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(generated, null, 2));
  return generated;
}

let vapidInitialized = false;

export function initWebPush(): string {
  const keys = getOrGenerateVapidKeys();
  if (!vapidInitialized) {
    webpush.setVapidDetails(
      'https://ukdc.github.io/dtek-svitlo-app',
      keys.publicKey,
      keys.privateKey
    );
    vapidInitialized = true;
  }
  return keys.publicKey;
}

/**
 * Subscriptions hold push endpoints and keys, so on GitHub Actions they are read from the private
 * Cloudflare store (cloudflare/subs), never from the public repository. Locally (no SUBS_API_URL)
 * a git-ignored state/subscriptions.json is used for development.
 */
function remoteStore(): { url: string; secret: string } | null {
  const url = process.env.SUBS_API_URL;
  const secret = process.env.SUBS_SECRET;
  return url && secret ? { url: url.replace(/\/+$/, ''), secret } : null;
}

export async function loadSubscribers(): Promise<SubscriberProfile[]> {
  const remote = remoteStore();
  if (remote) {
    // Fail loudly: silently treating an outage as "no subscribers" would stop all alerts unnoticed.
    const res = await fetch(`${remote.url}/internal/subscribers`, {
      headers: { Authorization: `Bearer ${remote.secret}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Subscription store answered HTTP ${res.status}`);
    const data = (await res.json()) as { subscribers?: unknown };
    if (!Array.isArray(data.subscribers)) throw new Error('Subscription store: bad response');
    return data.subscribers as SubscriberProfile[];
  }
  if (process.env.GITHUB_ACTIONS === 'true') {
    throw new Error(
      'SUBS_API_URL / SUBS_SECRET are not configured: refusing to run without the subscription store'
    );
  }
  return loadLocalSubscribers();
}

/** Drop a dead (expired) endpoint from whichever store is in use. */
export async function removeSubscriberByEndpoint(endpoint: string): Promise<void> {
  const remote = remoteStore();
  if (remote) {
    try {
      await fetch(`${remote.url}/internal/remove`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${remote.secret}` },
        body: JSON.stringify({ endpoint }),
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      // best effort: the next run retries after the next 404/410
    }
    return;
  }
  saveSubscribers(loadLocalSubscribers().filter((s) => s.subscription?.endpoint !== endpoint));
}

function loadLocalSubscribers(): SubscriberProfile[] {
  ensureStateDir();
  if (!fs.existsSync(SUBSCRIPTIONS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf-8'));
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

export function saveSubscribers(list: SubscriberProfile[]): void {
  ensureStateDir();
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(list, null, 2));
}

/** Local development only (Express dev server); production subscribes through cloudflare/subs. */
export function upsertSubscriber(profile: SubscriberProfile): SubscriberProfile {
  const list = loadLocalSubscribers();
  const idx = list.findIndex(
    (s) =>
      s.id === profile.id ||
      (profile.subscription?.endpoint &&
        s.subscription?.endpoint === profile.subscription.endpoint)
  );

  const updated: SubscriberProfile = {
    ...profile,
    updatedAt: new Date().toISOString(),
  };

  if (idx >= 0) {
    list[idx] = updated;
  } else {
    list.push(updated);
  }
  saveSubscribers(list);
  return updated;
}

export function loadSnapshot(): ScheduleSnapshotFile {
  ensureStateDir();
  if (!fs.existsSync(SNAPSHOT_FILE)) {
    return {
      updatedAt: new Date().toISOString(),
      groups: {},
      notifiedEvents: {},
      recentChanges: [],
    };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
    return {
      updatedAt: raw.updatedAt || new Date().toISOString(),
      groups: raw.groups || {},
      notifiedEvents: raw.notifiedEvents || {},
      recentChanges: Array.isArray(raw.recentChanges) ? raw.recentChanges : [],
    };
  } catch {
    return {
      updatedAt: new Date().toISOString(),
      groups: {},
      notifiedEvents: {},
      recentChanges: [],
    };
  }
}

export function saveSnapshot(snap: ScheduleSnapshotFile): void {
  ensureStateDir();
  // Prune notifiedEvents older than 48 hours
  const cutoff = Date.now() - 48 * 3600 * 1000;
  for (const [k, iso] of Object.entries(snap.notifiedEvents)) {
    const t = new Date(iso).getTime();
    if (isNaN(t) || t < cutoff) {
      delete snap.notifiedEvents[k];
    }
  }
  snap.recentChanges = snap.recentChanges.slice(0, 30);

  // The bot commits state/ to git every run: skip the write when only `updatedAt` would differ,
  // otherwise every 10-minute run produces a ~250 KB commit even when nothing changed.
  const stripTs = (x: ScheduleSnapshotFile) => JSON.stringify({ ...x, updatedAt: '' });
  try {
    if (fs.existsSync(SNAPSHOT_FILE)) {
      const prev = JSON.parse(fs.readFileSync(SNAPSHOT_FILE, 'utf-8'));
      if (stripTs(prev) === stripTs(snap)) return;
    }
  } catch {
    // unreadable previous file -> just overwrite
  }
  fs.writeFileSync(SNAPSHOT_FILE, JSON.stringify(snap, null, 2));
}

/**
 * Dedup ledger is namespaced per subscriber ("<subId>|<eventId>"): several devices can legitimately
 * hold the same address id (e.g. the built-in "addr_default_kyiv"), and a shared ledger made the first
 * device's notification suppress everyone else's. Legacy un-namespaced entries are still honoured
 * so a deploy does not re-send alerts that were already delivered.
 */
export function ledgerKey(subId: string, eventId: string): string {
  return `${subId}|${eventId}`;
}

export function ledgerViewFor(
  ledger: Record<string, string>,
  subId: string
): Record<string, string> {
  const view: Record<string, string> = {};
  const prefix = `${subId}|`;
  for (const [k, v] of Object.entries(ledger)) {
    if (k.startsWith(prefix)) view[k.slice(prefix.length)] = v;
    else if (!k.includes('|')) view[k] = v; // legacy entry
  }
  return view;
}

export async function sendPushPayload(
  subscription: webpush.PushSubscription,
  payload: {
    title: string;
    body: string;
    tag?: string;
    addressId?: string;
    url?: string;
    icon?: string;
  }
): Promise<boolean> {
  initWebPush();
  try {
    await webpush.sendNotification(
      subscription,
      JSON.stringify({
        title: payload.title,
        body: payload.body,
        tag: payload.tag || 'svitlo-alert',
        addressId: payload.addressId,
        url: payload.url || './',
        icon: payload.icon,
        timestamp: Date.now(),
      })
    );
    return true;
  } catch (err: any) {
    const host = (() => {
      try {
        return new URL(subscription.endpoint).host;
      } catch {
        return 'unknown-endpoint';
      }
    })();
    console.error(
      `[Push] send failed (${host}): status=${err?.statusCode ?? 'n/a'} ${
        err?.body ? String(err.body).slice(0, 200) : err?.message || ''
      }`
    );
    // 410 Gone or 404 Not Found means subscription expired on iOS
    if (err?.statusCode === 410 || err?.statusCode === 404) {
      await removeSubscriberByEndpoint(subscription.endpoint);
    }
    return false;
  }
}

/**
 * Executes a full check cycle:
 * 1. Fetches fresh multi-source schedules (Outage-Data-UA + YASNO API v2 + DTEK)
 * 2. Detects intraday schedule changes for any group and notifies subscribed addresses
 * 3. Checks [10..32] minute sliding window before outage start & restoration for each address
 * 4. Saves updated snapshot & notifiedEvents ledger
 */
export async function runScheduleAndNotificationCheck(options?: {
  forceRefresh?: boolean;
  sendTestPushToAll?: boolean;
}): Promise<{
  checkedGroups: number;
  alertsSent: number;
  changesDetected: number;
}> {
  initWebPush();
  const bundle = await fetchMultiSourceSchedules(options?.forceRefresh ?? true);
  const snapshot = loadSnapshot();
  const subscribers = await loadSubscribers();
  console.log(`[Push] ${subscribers.length} subscriber(s) loaded`);
  const { nowMinutes } = getKyivTimeContext();

  let alertsSent = 0;
  let changesDetected = 0;

  if (options?.sendTestPushToAll) {
    for (const sub of subscribers) {
      if (sub.subscription) {
        const ok = await sendPushPayload(sub.subscription, {
          title: TEST_PUSH_TITLE,
          body: TEST_PUSH_BODY,
          tag: 'test-push',
        });
        if (ok) alertsSent++;
      }
    }
  }

  // 1. Check intraday schedule changes across all groups
  const allEntries: Array<{
    region: 'kem' | 'krem';
    group: string;
    today: DaySchedule;
    tomorrow: DaySchedule;
  }> = [];

  for (const [grp, sched] of Object.entries(bundle.kem)) {
    allEntries.push({
      region: 'kem',
      group: grp,
      today: sched.today,
      tomorrow: sched.tomorrow,
    });
  }
  for (const [grp, sched] of Object.entries(bundle.krem)) {
    allEntries.push({
      region: 'krem',
      group: grp,
      today: sched.today,
      tomorrow: sched.tomorrow,
    });
  }

  const changedGroups = new Map<string, ScheduleChange[]>();

  for (const item of allEntries) {
    const snapKey = `${item.region}:${item.group}`;
    const prev = snapshot.groups[snapKey];

    if (prev) {
      const todayDiff = computeScheduleDiff(prev.today, item.today, 'Сьогодні');
      const tomorrowDiff = computeScheduleDiff(
        prev.tomorrow,
        item.tomorrow,
        'Завтра'
      );

      const changesForGroup: ScheduleChange[] = [];
      if (todayDiff.hasChanged) {
        changesForGroup.push({ dayLabel: 'Сьогодні', prev: prev.today, next: item.today });
        changesDetected++;
        snapshot.recentChanges.unshift({
          id: `${snapKey}:${Date.now()}:today`,
          groupKey: snapKey,
          region: item.region,
          group: item.group,
          dayLabel: 'Сьогодні',
          summaryText: todayDiff.summaryText,
          detectedAt: new Date().toISOString(),
        });
      }
      if (tomorrowDiff.hasChanged) {
        changesForGroup.push({ dayLabel: 'Завтра', prev: prev.tomorrow, next: item.tomorrow });
        changesDetected++;
        snapshot.recentChanges.unshift({
          id: `${snapKey}:${Date.now()}:tomorrow`,
          groupKey: snapKey,
          region: item.region,
          group: item.group,
          dayLabel: 'Завтра',
          summaryText: tomorrowDiff.summaryText,
          detectedAt: new Date().toISOString(),
        });
      }

      if (changesForGroup.length > 0) {
        changedGroups.set(snapKey, changesForGroup);
      }
    }

    snapshot.groups[snapKey] = {
      today: item.today,
      tomorrow: item.tomorrow,
    };
  }

  // 2. Process each subscriber & their saved addresses
  for (const sub of subscribers) {
    if (!sub.subscription) continue;

    const quietActive = isWithinQuietHours(
      nowMinutes,
      sub.quietHours?.enabled ?? false,
      sub.quietHours?.start || '23:00',
      sub.quietHours?.end || '07:00'
    );

    if (quietActive) continue;

    for (const addr of sub.addresses || []) {
      const snapKey = `${addr.region}:${addr.group}`;
      const regionMap = addr.region === 'kem' ? bundle.kem : bundle.krem;
      const groupSched = regionMap[addr.group];
      if (!groupSched) continue;

      // A) Intraday schedule change notifications
      const groupChanges = changedGroups.get(snapKey);
      if (addr.notifyOnChange && groupChanges) {
        const { title: changeTitle, body: changeBody } = buildChangeNotification(
          getShortAddress(addr),
          groupChanges
        );

        const changeHash = `${groupSched.today.dateKey}:${groupSched.today.slots.join('')}:${groupSched.tomorrow.slots.join('')}`;
        const changeEventId = ledgerKey(sub.id, `${addr.id}:change:${changeHash}`);

        if (
          !snapshot.notifiedEvents[changeEventId] &&
          !snapshot.notifiedEvents[`${addr.id}:change:${changeHash}`]
        ) {
          const sent = await sendPushPayload(sub.subscription, {
            title: changeTitle,
            body: changeBody,
            tag: `change-${addr.id}`,
            addressId: addr.id,
            icon: './icon-change.svg',
          });
          if (sent) {
            snapshot.notifiedEvents[changeEventId] = new Date().toISOString();
            alertsSent++;
          }
        }
      }

      // B) Sliding window [10..32]m notifications (~30m before outage start or restoration).
      // The trigger (Cloudflare Worker) fires every 5 min, so a 22 min window is enough; the wider
      // 10..42 window was only needed to survive the unreliable GitHub cron.
      const triggers = evaluateUpcomingAlerts(
        addr,
        groupSched.today,
        nowMinutes,
        ledgerViewFor(snapshot.notifiedEvents, sub.id),
        10,
        32,
        groupSched.tomorrow
      );

      for (const trig of triggers) {
        const sent = await sendPushPayload(sub.subscription, {
          title: trig.title,
          body: trig.body,
          tag: trig.eventId,
          addressId: addr.id,
          icon: trig.icon || './icon-192.svg',
        });
        if (sent) {
          snapshot.notifiedEvents[ledgerKey(sub.id, trig.eventId)] =
            new Date().toISOString();
          alertsSent++;
        }
      }
    }
  }

  snapshot.updatedAt = new Date().toISOString();
  saveSnapshot(snapshot);

  return {
    checkedGroups: allEntries.length,
    alertsSent,
    changesDetected,
  };
}
