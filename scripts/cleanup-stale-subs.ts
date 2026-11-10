import { loadSubscribers } from '../server/services/notificationScheduler.ts';

const SUBS_API_URL =
  process.env.SUBS_API_URL?.replace(/\/+$/, '') ||
  'https://svitlo-subs.svitlo-b79d27.workers.dev';
const SUBS_SECRET = process.env.SUBS_SECRET;

export const KNOWN_STALE_IDS = new Set([
  'ios_57139a8c90424dca9f54336c643cdc98',
  'ios_8919081054764878abec8f4ba446fcf1',
  'ios_e0e07afb544a45e389f99814ed33dc09',
]);

export async function removeSubscriber(
  apiUrl: string,
  secret: string,
  endpoint: string
): Promise<boolean> {
  const res = await fetch(`${apiUrl}/internal/remove`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ endpoint }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    console.error(`[cleanup] Failed to remove subscriber: HTTP ${res.status}`);
    return false;
  }
  const data = (await res.json()) as { ok?: boolean; removed?: boolean };
  return !!data.removed;
}

export function pickSubscribersToRemove<
  T extends { id: string; updatedAt?: string; subscription?: { endpoint?: string } | null },
>(subs: T[], customTargetIds?: Set<string>): T[] {
  if (customTargetIds && customTargetIds.size > 0) {
    return subs.filter((s) => customTargetIds.has(s.id));
  }
  // By default, match known stale subscriber IDs
  const matched = subs.filter((s) => KNOWN_STALE_IDS.has(s.id));
  if (matched.length > 0) return matched;

  // Fallback: if there are multiple subscribers and all belong to the same device reinstall cycle,
  // we keep the most recently updated one and purge the rest.
  if (subs.length > 1) {
    const sorted = [...subs].sort((a, b) => {
      const ta = a.updatedAt ? Date.parse(a.updatedAt) : 0;
      const tb = b.updatedAt ? Date.parse(b.updatedAt) : 0;
      return ta - tb;
    });
    // Return all except the newest one
    return sorted.slice(0, sorted.length - 1);
  }

  return [];
}

async function main() {
  if (!SUBS_SECRET) {
    throw new Error('SUBS_SECRET is required to clean up subscriptions');
  }

  console.log(`[cleanup] Connecting to ${SUBS_API_URL}...`);
  const subs = await loadSubscribers();
  console.log(`[cleanup] Loaded ${subs.length} total subscribers.`);

  if (subs.length === 0) {
    console.log('[cleanup] No subscribers found.');
    return;
  }

  const customTargetIds = process.env.TARGET_IDS
    ? new Set(
        process.env.TARGET_IDS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      )
    : undefined;

  const toRemove = pickSubscribersToRemove(subs, customTargetIds);
  console.log(`[cleanup] Identified ${toRemove.length} stale subscriber(s) to remove.`);

  for (const sub of toRemove) {
    const endpoint = sub.subscription?.endpoint;
    if (!endpoint) {
      console.warn(`[cleanup] Skipping ${sub.id}: no subscription endpoint`);
      continue;
    }
    console.log(`[cleanup] Removing stale subscriber id=${sub.id}...`);
    const ok = await removeSubscriber(SUBS_API_URL, SUBS_SECRET, endpoint);
    console.log(`[cleanup] Result for ${sub.id}: ${ok ? 'REMOVED' : 'NOT FOUND OR FAILED'}`);
  }

  // Verify remaining
  const remaining = await loadSubscribers();
  console.log(`[cleanup] Verification: ${remaining.length} subscriber(s) currently registered.`);
  for (const r of remaining) {
    console.log(`[cleanup] Active subscriber: id=${r.id}, updatedAt=${r.updatedAt || 'n/a'}`);
  }
}

// Only execute if called directly from CLI
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[cleanup] Fatal error:', err);
    process.exit(1);
  });
}
