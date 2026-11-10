import fs from 'node:fs';
import webpush from 'web-push';
import { sendPushPayload, loadSubscribers } from '../server/services/notificationScheduler.ts';

async function main() {
  const subs = loadSubscribers();
  console.log(`Found ${subs.length} subscribers.`);
  if (subs.length === 0) {
    console.log('No subscribers.');
    return;
  }

  for (const sub of subs) {
    if (!sub.subscription) continue;
    console.log(`Sending test notification to subscriber ${sub.id}...`);

    console.log(`Sending sample restoration push to ${sub.id}...`);
    const ok1 = await sendPushPayload(sub.subscription, {
      title: '🔋 Світло буде о 16:30 • Дім',
      body: 'до 20:00 · 3,5 год зі світлом',
      tag: `test-on-${Date.now()}`,
      icon: './icon-on.svg',
    });
    console.log(`Restoration push result: ${ok1}`);

    console.log(`Sending sample outage push to ${sub.id}...`);
    const ok2 = await sendPushPayload(sub.subscription, {
      title: '🪫 Відключення о 12:00 • Дім',
      body: 'до 16:30 · 4,5 год без світла',
      tag: `test-off-${Date.now()}`,
      icon: './icon-off.svg',
    });
    console.log(`Outage push result: ${ok2}`);
  }
}

main().catch(console.error);
