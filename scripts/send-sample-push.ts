import { sendPushPayload, loadSubscribers } from '../server/services/notificationScheduler.ts';

/**
 * Sends one sample of each push type (outage, restoration, schedule change) to every subscriber,
 * so the real look of the texts and emoji can be checked on the device.
 * Run in GitHub Actions via the «sample_push» input of push-check.yml (it has the secrets), or locally with
 * SUBS_API_URL / SUBS_SECRET / VAPID_* set.
 */
const SAMPLES = [
  { kind: 'off', title: '🪫 16:00 вимкнення', body: 'Дім · до 20:00 · 4 год без світла', icon: './icon-off.svg' },
  { kind: 'on', title: '🔋 20:00 увімкнення', body: 'Дім · до 24:00 · 4 год зі світлом', icon: './icon-on.svg' },
  {
    kind: 'change',
    title: '🗓️ Графік змінено',
    body: 'Дім · сьогодні: відключення 16:00–20:00 (було 14:00–18:00)',
    icon: './icon-change.svg',
  },
] as const;

async function main() {
  const subs = await loadSubscribers();
  console.log(`Found ${subs.length} subscribers.`);
  if (subs.length === 0) {
    console.log('No subscribers.');
    return;
  }

  for (const sub of subs) {
    if (!sub.subscription) continue;
    for (const s of SAMPLES) {
      const ok = await sendPushPayload(sub.subscription, {
        title: s.title,
        body: s.body,
        tag: `sample-${s.kind}-${Date.now()}`,
        icon: s.icon,
      });
      console.log(`Sample "${s.kind}" -> subscriber ${sub.id}: ${ok ? 'sent' : 'FAILED'}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
