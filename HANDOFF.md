# Svitlo (Світло) • Project Handoff Document

> **App Name**: «Світло»  
> **Repository**: [UkDC/dtek-svitlo-app](https://github.com/UkDC/dtek-svitlo-app) (branches: `main`, `gh-pages`)  
> **Production URL**: [https://ukdc.github.io/dtek-svitlo-app/](https://ukdc.github.io/dtek-svitlo-app/)  
> **Current Version**: `17.1.0` (sw cache `svitlo-pwa-v17-1`, build `2026-11-09T10:25:00Z`)  
> **Platform**: iPhone PWA (iOS 18.7+ Web Push over Apple APNs) + Desktop / Android responsive web app.

---

## 1. Project Overview & Scope
- **Mission**: Precision tracking of DTEK electricity outage schedules in **Kyiv** (`dtek-kem`) and **Kyiv Oblast** (`dtek-krem`), delivering background push notifications directly to iPhone lock screens 30 minutes before outages and restorations.
- **Data Sources**: Multi-source fallback engine:
  1. *Outage-Data-UA* (fact-based DTEK scrapers)
  2. *YASNO API v2* (minute-accurate slots)
  3. *DTEK regional endpoints*
- **Key UX Commitments**:
  - App name strictly **«Світло»** across all manifests, titles, and headers.
  - Exactly two day tabs: **«Сьогодні»** and **«Завтра»**.
  - **No countdown timer** on the Hero card (scannable status text only, e.g. «світло є до 16:00», «немає світла до 18:30»).
  - Clean alphabetical sorting for Kyiv streets and Kyiv Oblast settlements.
  - Standalone PWA on iOS does **not** support pull-to-refresh (overscroll disabled by WebKit); auto-update triggers on app resume and manual refresh button.
  - Service worker never auto-reloads the page on `controllerchange` to prevent breaking user modals or copy flows.

---

## 2. Notification Specifications (Apple APNs & Lock Screen)

### Copywriting Rules:
1. **Language**: Strictly **Українська мова** (matching DTEK & Kyiv Digital standards).
2. **Character Budget**: Tailored for iPhone lock screen & Apple Watch (~38 chars for single-line title).
3. **No Group Code Clutter**: The group number (`• Група 21.1`) is **STRICTLY EXCLUDED** from all notification titles and bodies.
4. **Actionable Details**: Notifications always state the exact duration in hours and intervals.

### Push Formats:

#### 1. 🔴 Outage Warning (~30 minutes before)
- **Title**: `🔴 Відключення за 30 хв • ${shortAddr}`  
  *(e.g., `🔴 Відключення за 30 хв • Дім` or `🔴 Відключення за 30 хв • с. Гатне`; the name is the user's short address alias, else the settlement — never street/house, see `getShortAddress`)*
- **Body**: `Період: 12:00 – 16:30 (4.5 год)`
- **Icon**: `public/icon-off.svg` (Dark card, glowing ruby neon bolt with slash)

#### 2. 🟢 Restoration Warning (~30 minutes before)
- **Title**: `🟢 Увімкнення за 30 хв • ${shortAddr}`
- **Body**: `Світло буде: 16:30 – 20:00 (3.5 год)`  
  *(if on until end of day: `Світло буде: 16:30 – 24:00 (7.5 год)`)*
- **Icon**: `public/icon-on.svg` (Deep card, neon emerald surge with white-hot core)

#### 3. 🔄 Intraday Schedule Change
- **Title**: `🔄 Графік змінено • ${shortAddr}`
- **Body**:
  - *If power is currently ON*: `Наступне відключення: 18:00 – 21:00 (3 год)` (or `завтра 08:00 – 12:00 (4 год)`)
  - *If power is currently OFF*: `Включення о 16:30 • Наступне відключення: 20:00 – 23:00 (3 год)`
  - *If no more outages*: `Відключень більше не заплановано`
- **Icon**: `public/icon-change.svg` (Sapphire card, dual orbiting sync arrows)

---

## 3. Active User Configuration & Subscriber State

- **Subscriber state** lives in `state/subscriptions.json` (push endpoint + keys + saved addresses + quiet hours).
  Its contents are intentionally NOT reproduced here: this repo is public. Quiet hours default to 23:00–07:00.
- **Delivery Verified**: Successfully delivered sample pushes to Apple APNs (`HTTP 201 Created`).

---

## 4. Key Files & Architecture

| File Path | Role & Responsibilities |
| :--- | :--- |
| `src/services/scheduleNormalizer.ts` | Multi-source parsing (DTEK/YASNO), `getCurrentAddressStatus`, deterministic `evaluateUpcomingAlerts` with interval duration calculation. |
| `server/services/notificationScheduler.ts` | Apple APNs push sender (`sendPushPayload`), `[10..42]m` sliding window checker, deduplication via `notifiedEvents`, schedule change calculation. |
| `src/services/pushSyncService.ts` | Client VAPID subscriber, sync engine (Backend + GitHub Contents API), `triggerTestNotification`. |
| `src/components/NotificationSettingsModal.tsx` | UI for push activation, test push dispatch, and iPhone subscription token management. |
| `public/sw.js` | Service Worker push listener with dynamic icon routing (`icon-off.svg`, `icon-on.svg`, `icon-change.svg`). |
| `scripts/send-sample-push.ts` | CLI script to test live push delivery directly to all registered subscribers. |
| `scripts/chrome-e2e.ts` | Chrome headless CDP test suite verifying tabs, addresses, search, modals, and schedule rendering. |
| `src/index.css` | Neon animations: `pulseGlowOn`, `pulseGlowOff`, `badgeShimmer`, `markerBeacon`, `alertPulseOff`, `alertPulseOn`. |

---

## 5. Security & Build Hygiene

- **VAPID Security**: keys come ONLY from the `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` repository secrets (CI fails without them).
    The deploy workflow publishes the public key to `dist/state/vapid-public.json` from the secret. `*vapid-keys.json` and
    `state/vapid-public.json` are git-ignored. No keys may ever be committed.
- **Verification Commands**:
  - `npm run typecheck`: `tsc --noEmit` (also a gate in the deploy workflow).
  - `npm test`: Runs Vitest suite (26 tests passing).
  - `npm run sync:schedules`: refreshes `state/combined-schedules.json` only (no push, no ledger changes; used by the deploy workflow).
  - `npm run test:e2e`: Runs headless Chrome CDP test suite.
  - `npx tsx scripts/send-sample-push.ts`: Sends live test pushes to user's device via APNs.
  - `npm run build && mkdir -p dist/state && cp state/*.json dist/state/ && cp public/version.json dist/ && rm -f dist/state/*vapid-keys.json dist/state/subscriptions.json`: Builds production bundle.

---

## 6. How to Resume in a New Chat
When starting a new conversation:
1. Provide the repository link: `https://github.com/UkDC/dtek-svitlo-app`.
2. Reference this `HANDOFF.md`.
3. State your testing observations or new feature requests (e.g. adjustments to alert timing, widget additions, or schedule data tweaks).

---

## 7. Audit notes (2026-11-09) — open items that need an owner decision

Fixed in code (see git log): date-keyed parsing of Outage-Data-UA; midnight rollover of cached schedules; outages that
cross 24:00 (hero + alerts); «Графік очікується» state; per-subscriber dedup ledger; real lead time in push titles;
«Графік змінено» body (next outage was never shown while power was OFF); CORS-breaking `Cache-Control` header on the
live fetch; deploy workflow no longer sends pushes; PNG icons for iOS/Android; silent push errors are now logged.

**Not fixed — requires decisions / account actions:**
1. **Public repo exposes push subscription + home addresses** (`state/subscriptions.json`, this file's history) **and the
   VAPID private key is recoverable from `server/services/notificationScheduler.ts` (`DEFAULT_VAPID_KEYS`)**.
   Plan: generate a new VAPID pair → set `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` repo secrets → update
   `state/vapid-public.json` → remove the hard-coded fallback → re-subscribe the phone (the app renews on key mismatch).
   Move subscriptions out of the public repo (private state repo, or encrypt client-side).
2. **GitHub Actions cron is not a reliable 10-minute scheduler**: `push-check.yml` has run once since creation.
   For «30 min before» alerts use an external trigger (e.g. Cloudflare Workers Cron / cron-job.org → `workflow_dispatch`).
3. Client-side fine-grained PAT in `localStorage` has write access to the repo (and therefore to the deployed code).

