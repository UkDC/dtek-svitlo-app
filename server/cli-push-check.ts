import { runScheduleAndNotificationCheck } from './services/notificationScheduler.ts';

async function main() {
  const sendTest =
    process.env.SEND_TEST_PUSH === 'true' ||
    process.argv.includes('--test-push');

  console.log(
    `[SvitloPulse Worker] Starting schedule sync & push check (testPush=${sendTest})...`
  );
  const result = await runScheduleAndNotificationCheck({
    forceRefresh: true,
    sendTestPushToAll: sendTest,
  });
  console.log(
    `[SvitloPulse Worker] Completed: checkedGroups=${result.checkedGroups}, changesDetected=${result.changesDetected}, alertsSent=${result.alertsSent}`
  );
}

main().catch((err) => {
  console.error('[SvitloPulse Worker] Error:', err);
  process.exit(1);
});
