import { fetchMultiSourceSchedules } from './services/multiSourceClient.ts';

/**
 * Refreshes state/combined-schedules.json (+ public/state copy) WITHOUT touching push subscribers.
 * Used by the deploy workflow: a deploy must never send notifications or mutate the dedup ledger.
 */
async function main() {
  const bundle = await fetchMultiSourceSchedules(true);
  console.log(
    `[sync-schedules] kem=${Object.keys(bundle.kem).length} krem=${Object.keys(bundle.krem).length} source="${bundle.sourceLabel}"`
  );
}

main().catch((err) => {
  console.error('[sync-schedules] Error:', err);
  process.exit(1);
});
