import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import cors from 'cors';
import {
  fetchMultiSourceSchedules,
  lookupHouseGroupServer,
  searchStreetsServer,
} from './services/multiSourceClient.ts';
import {
  SubscriberProfile,
  initWebPush,
  loadSnapshot,
  loadSubscribers,
  runScheduleAndNotificationCheck,
  sendPushPayload,
  upsertSubscriber,
} from './services/notificationScheduler.ts';
import { RegionId } from '../src/services/scheduleNormalizer.ts';

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Initialize VAPID keys on boot and export public key to public/state/vapid-public.json
const vapidPublicKey = initWebPush();
try {
  const pubStateDir = path.resolve(process.cwd(), 'public/state');
  const stateDir = path.resolve(process.cwd(), 'state');
  fs.mkdirSync(pubStateDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const keyJson = JSON.stringify({ publicKey: vapidPublicKey }, null, 2);
  fs.writeFileSync(path.join(pubStateDir, 'vapid-public.json'), keyJson);
  fs.writeFileSync(path.join(stateDir, 'vapid-public.json'), keyJson);
} catch {
  // ignore
}

app.get('/api/health', async (_req, res) => {
  const snap = loadSnapshot();
  const subs = await loadSubscribers().catch(() => []);
  res.json({
    ok: true,
    updatedAt: snap.updatedAt,
    subscribersCount: subs.length,
    recentChangesCount: snap.recentChanges.length,
    vapidPublicKey,
  });
});

app.get('/api/schedules', async (req, res) => {
  try {
    const force = req.query.refresh === '1' || req.query.refresh === 'true';
    const bundle = await fetchMultiSourceSchedules(force);
    const snap = loadSnapshot();
    res.json({
      ...bundle,
      recentChanges: snap.recentChanges,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to fetch schedules' });
  }
});

app.get('/api/lookup/streets', async (req, res) => {
  const region = (req.query.region === 'krem' ? 'krem' : 'kem') as RegionId;
  const city = String(req.query.city || 'м. Київ');
  const q = String(req.query.q || '');
  const streets = await searchStreetsServer(region, city, q);
  res.json({ streets });
});

app.get('/api/lookup/houses', async (req, res) => {
  const region = (req.query.region === 'krem' ? 'krem' : 'kem') as RegionId;
  const city = String(req.query.city || 'м. Київ');
  const street = String(req.query.street || '');
  const streetId = req.query.streetId ? Number(req.query.streetId) : undefined;
  const q = String(req.query.q || '');
  const result = await lookupHouseGroupServer(region, city, street, streetId, q);
  res.json(result);
});

app.get('/api/push/vapid-public-key', (_req, res) => {
  res.json({ publicKey: vapidPublicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const body = req.body as Partial<SubscriberProfile>;
  const id = body.id || `sub_${Date.now()}`;
  const saved = upsertSubscriber({
    id,
    subscription: body.subscription || null,
    addresses: Array.isArray(body.addresses) ? body.addresses : [],
    quietHours: body.quietHours || {
      enabled: true,
      start: '23:00',
      end: '07:00',
    },
    updatedAt: new Date().toISOString(),
  });
  res.json({ ok: true, subscriber: saved });
});

app.post('/api/push/test', async (req, res) => {
  const { subscription, addressLabel } = req.body || {};
  if (subscription && subscription.endpoint) {
    const sent = await sendPushPayload(subscription, {
      title: '⚡ Світло: Проверка связи',
      body: addressLabel
        ? `Push-сповіщення для «${addressLabel}» активні! Ви отримаєте сигнал приблизно за 30 хв до відключення та увімкнення світла.`
        : 'Push-уведомления на iPhone настроены и работают!',
      tag: 'test-push',
    });
    res.json({ ok: sent });
    return;
  }

  const stats = await runScheduleAndNotificationCheck({
    forceRefresh: false,
    sendTestPushToAll: true,
  });
  res.json({ ok: stats.alertsSent > 0, alertsSent: stats.alertsSent });
});

// Serve static files from dist/ and state/ in production/preview
const distDir = path.resolve(process.cwd(), 'dist');
const stateDir = path.resolve(process.cwd(), 'state');
app.use('/state', express.static(stateDir));

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/state')) {
      next();
      return;
    }
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[SvitloPulse Server] Listening on http://localhost:${PORT}`);
  // Initial sync on startup
  runScheduleAndNotificationCheck({ forceRefresh: true }).catch((err) =>
    console.error('Initial schedule sync error:', err)
  );

  // Background check every 10 minutes (600_000 ms) for fresh schedules, and every 60 seconds for 30-min alerts
  setInterval(() => {
    runScheduleAndNotificationCheck({ forceRefresh: false }).catch(() => {});
  }, 60_000);

  setInterval(() => {
    runScheduleAndNotificationCheck({ forceRefresh: true }).catch(() => {});
  }, 10 * 60_000);
});
