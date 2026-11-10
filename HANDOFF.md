# Svitlo (Світло) • Project Handoff Document

> **App Name**: «Світло»  
> **Repository**: [UkDC/dtek-svitlo-app](https://github.com/UkDC/dtek-svitlo-app) (branches: `main`, `gh-pages`)  
> **Production URL**: [https://ukdc.github.io/dtek-svitlo-app/](https://ukdc.github.io/dtek-svitlo-app/)  
> **Current Version**: `18.5.1` (sw cache `svitlo-pwa-v18-5-1`, build `2026-11-10T10:00:00Z`; keep `CURRENT_BUILD_TIMESTAMP` in `src/App.tsx` and `public/version.json` equal on release)  
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
  - **No countdown timer**: the day ring («Кільце доби», design B) is a 12-hour clock dial (12 at the top, clockwise): a thick main ring = the current half of the day and a thin outer track = the next 12 hours; it shows status + «до HH:MM» in its centre, a clock hand + «now» marker on the main ring, the day's intervals below.
  - Clean alphabetical sorting for Kyiv streets and Kyiv Oblast settlements.
  - Standalone PWA on iOS does **not** support pull-to-refresh (overscroll disabled by WebKit); auto-update triggers on mount, every 10 min and on app resume; the «Дані ДТЕК від …» line is also a refresh button.
  - Service worker never auto-reloads the page on `controllerchange` to prevent breaking user modals or copy flows.

---

## 2. Notification Specifications (Apple APNs & Lock Screen)

### Copywriting Rules:
1. **Language**: Strictly **Українська мова** (matching DTEK & Kyiv Digital standards).
2. **Character Budget**: Tailored for iPhone lock screen & Apple Watch (~38 chars for single-line title).
3. **No Group Code Clutter**: The group number (`• Група 21.1`) is **STRICTLY EXCLUDED** from all notification titles and bodies.
4. **Actionable Details**: Notifications always state the exact duration in hours and intervals.

### Push Formats:

#### 1. 🪫 Outage Warning (10–32 min before)
- **Title**: `🪫 Відключення о 16:00` — names the clock time, NOT a lead time (the window is 10–32 min). No address name in titles: on iPhone the title is cut at ~25 chars (seen on a device), the name would be lost.
- **Body**: `Дім · до 20:00 · 4 год без світла`
  *(`Дім` = `shortAddr`: the user's short alias, else the settlement — never street/house, see `getShortAddress`)* (`до завтра 04:00` when it ends the next day; decimal comma: `4,5 год`)
- Builder: `evaluateUpcomingAlerts` in `src/services/scheduleNormalizer.ts`.

#### 2. 🔋 Restoration Warning (10–32 min before)
- **Title**: `🔋 Світло буде о 20:00`
- **Body**: `Дім · до 24:00 · 4 год зі світлом` (light period merged across midnight; `Дім · далі можливі відключення` when a «maybe» period follows)

#### 3. 🗓️ Schedule changed (`buildChangeNotification`)
- **Title**: `🗓️ Графік на сьогодні змінено` / `…на завтра змінено` / `🗓️ Графік змінено` (both days) / `🗓️ Опубліковано графік на завтра` (tomorrow was not published before)
- **Body**: `Дім · відключення 16:00–20:00 (було 14:00–18:00)`; `Дім · без відключень (було …)`; `Дім · екстрені відключення`; `Дім · графік очікується`; both days → first line `Дім`, then `Сьогодні: …` / `Завтра: …`; ≤110 chars, truncated with «…».

#### 4. ✅ Test push: `✅ Сповіщення працюють` / `Попередимо за ~30 хв до відключення та увімкнення.` (`TEST_PUSH_TITLE/BODY`).

> The emoji in titles are the only per-type visual cue on iPhone: iOS most likely ignores the payload `icon`/`badge`
> (shows the PWA icon; reported by Apple forums / WebKit bug 280160, not verified by us). `icon-*.svg` matter for desktop/Android only.

#### 3. 🔄 Intraday Schedule Change
- **Title**: `🔄 Графік змінено • ${shortAddr}`
- **Body**:
  - *If power is currently ON*: `Наступне відключення: 18:00 – 21:00 (3 год)` (or `завтра 08:00 – 12:00 (4 год)`)
  - *If power is currently OFF*: `Включення о 16:30 • Наступне відключення: 20:00 – 23:00 (3 год)`
  - *If no more outages*: `Відключень більше не заплановано`
- **Icon**: `public/icon-change.svg` (Sapphire card, dual orbiting sync arrows)

---

## 3. Active User Configuration & Subscriber State

- **Subscriber state** (push endpoint + keys + group numbers + quiet hours) lives in a PRIVATE Cloudflare KV namespace
  behind the Worker `cloudflare/subs` (`svitlo-subs`), NOT in git. The app registers a device with an invitation code
  (`INVITE_CODES` Worker secret; link form `…/dtek-svitlo-app/#invite=CODE`) and receives a per-device write token.
  `push-check.yml` reads the list via `GET /internal/subscribers` with `SUBS_SECRET` (same value as the Worker secret
  and the GitHub repo secret). One KV key per device (`sub:<id>`, `ep:<sha256(endpoint)>` index). Street/house never
  leave the phone. Local development uses a git-ignored `state/subscriptions.json`. Quiet hours default to 23:00–07:00.
  Rotate: change `INVITE_CODES` (blocks new/updated registrations), or `SUBS_SECRET` in both places.
- **Delivery Verified**: Successfully delivered sample pushes to Apple APNs (`HTTP 201 Created`).

---

## 4. Key Files & Architecture

| File Path | Role & Responsibilities |
| :--- | :--- |
| `src/services/scheduleNormalizer.ts` | Multi-source parsing (DTEK/YASNO), `getCurrentAddressStatus`, deterministic `evaluateUpcomingAlerts` with interval duration calculation. |
| `server/services/notificationScheduler.ts` | Apple APNs push sender (`sendPushPayload`), `[10..32]m` sliding window checker (server; the in-app local check keeps 10..42), deduplication via `notifiedEvents`, schedule change calculation. |
| `src/services/pushSyncService.ts` | Client VAPID subscriber, sync engine (dev Backend + private Cloudflare store), `triggerTestNotification`. |
| `src/components/NotificationsPage.tsx` | Full-screen «Сповіщення» (design B-Notify): status, 3 switches (fixed 30-min lead, stated honestly), test push, «Додатково» (theme, quiet hours, invite code, iOS tip), «Вимкнути сповіщення» (`disablePush`). |
| `src/components/AddressPage.tsx` | Full-screen «Нова адреса»: Kyiv (debounced YASNO lookup via `svitlo-address`) / oblast (explicit lookup via `svitlo-lookup`, 20–90 s), suggestions, candidates chips, manual group grid as a fallback after a failure. |
| `src/components/DayRing.tsx`, `src/services/ringGeometry.ts` | Pure-SVG clock dial «G+» and its tested geometry. Main thick ring = current 12-hour half (past dimmed, remainder bright; flips at 12:00); thin outer track = what comes next (before noon: today 12–24; after noon: TOMORROW 00–12, dashed placeholder if tomorrow is unpublished); real 24-h digits inside the main ring and real 24-h digits outside the thin track (12/15/18/21, or 00/03/06/09 after noon, where the top label reads «завтра · 00»); the track has a small break at 12 o'clock (`TRACK_GAP_MINUTES`); digits are 13 viewBox units (≈13 px at 390 px width; `RING_PAD` adds viewBox room so outer digits are not clipped); no next-change mark on the ring (it is only in the centre text «до HH:MM»). `planDial()` is the single entry point (takes `slots`, `nowMinutes`, `nextDaySlots`); aria-label describes the whole day. |
| `src/services/oblastLookup.ts` | Client of the `svitlo-lookup` Worker: `/start` + polling `/result` (patient, 150 s). Needs the invite code. |
| `cloudflare/{address,lookup,subs,trigger}` | Workers: Kyiv address→group proxy; oblast lookup (dispatches `dtek-lookup.yml`, a runner polls dtek-krem.com.ua because DTEK blocks Cloudflare); private subscriber KV; cron trigger. |
| `public/sw.js` | Service Worker push listener with dynamic icon routing (`icon-off.svg`, `icon-on.svg`, `icon-change.svg`). |
| `scripts/send-sample-push.ts` | Sends one sample of each push type (🪫/🔋/🗓️) to all subscribers. Run from GitHub Actions: `push-check.yml` → Run workflow → `sample_push=true` (secrets live there); locally needs `SUBS_API_URL`/`SUBS_SECRET`/`VAPID_*`. |
| `scripts/chrome-e2e.ts` | **STALE** (pre-design-B selectors); do not rely on it. |
| `src/index.css` | Single stylesheet. Design B tokens (`--bg-*`, `--text-*`, `--ring-*`, `--cta-*`, `--switch-*`…) defined three times: `:root` (light), `prefers-color-scheme: dark`, `:root[data-theme='dark']`. Theme preference lives in `localStorage` `svitlo_theme_v2` ('system' = no key). |

---

## 5. Security & Build Hygiene

- **VAPID Security**: keys come ONLY from the `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` repository secrets (CI fails without them).
    The deploy workflow publishes the public key to `dist/state/vapid-public.json` from the secret. `*vapid-keys.json` and
    `state/vapid-public.json` are git-ignored. No keys may ever be committed.
- **Verification Commands**:
  - `npm run typecheck`: `tsc --noEmit` (also a gate in the deploy workflow).
  - `npm test`: Runs Vitest suite (135 tests, services/server only; no component tests).
  - `npm run sync:schedules`: refreshes `state/combined-schedules.json` only (no push, no ledger changes; used by the deploy workflow).
  - `npm run test:e2e`: stale (see above).
  - `npx tsx scripts/send-sample-push.ts`: Sends the three sample pushes to ALL subscribers via APNs (prefer the `sample_push` workflow input).
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
   Subscriptions were moved to the private store (see §3); the old `state/subscriptions.json` remains in git HISTORY,
   so the owner's phone must re-subscribe once («Пересоздать подписку» in the app) to invalidate the old endpoint.
2. **GitHub Actions cron is not a reliable 10-minute scheduler**: `push-check.yml` has run once since creation.
   For «30 min before» alerts use an external trigger (e.g. Cloudflare Workers Cron / cron-job.org → `workflow_dispatch`).
3. ~~Client-side fine-grained PAT in `localStorage`~~: the PAT path was removed; the app deletes a leftover token and the
   owner should revoke it in GitHub. Residual: `notifiedEvents` in the public `state/schedule-snapshot.json` still lists
   subscriber ids and address ids (no endpoints/keys). The legacy owner id `ios_<timestamp>` is guessable, so an invitee
   could overwrite that one record; new devices get random ids. The "test push" button is local-only now.


---

## 8. Design B, oblast lookup, what to test on a device (2026-11-10)

- **Design B «Кільце доби»** (light + dark): main screen = ring, legend, Сьогодні/Завтра, interval list; removed hourly grid,
  stats, bottom nav, header theme toggle. Only what is in the mockups; deviations are listed in PR #8.
- **Lead time is fixed at 30 min** (server window `[10..32]m`). The 15 min / 1 h chips and a separate «Зміна графіка»
  lead from the mockup are NOT built on purpose; do not add UI that the backend does not honour.
- **Group detection**: Kyiv → `svitlo-address` (YASNO). Oblast → `svitlo-lookup` + `dtek-lookup.yml` (needs invite code,
  daily cap, 20–90 s). Manual group grid is an emergency fallback shown only after a failed lookup.
  Kyiv house suggestions carry no group (the group is fetched on selection).
- **Not verified on a real device**: the oblast lookup flow end-to-end in the installed PWA; the changed iOS status-bar
  style (`default`). After the SW bump (`v18-5-1`) the installed PWA must be fully closed and reopened.
- **Owner housekeeping**: revoke the temporary Cloudflare API token; the invite code appeared in a chat transcript
  (rotate `INVITE_CODES` in `svitlo-subs` and `svitlo-lookup` if concerned); the `svitlo-trigger`/`svitlo-lookup` GitHub PATs
  expire after one year; old `refs/pull/*/head` content needs a GitHub Support purge if it must disappear.
- A11y note: the page behind a full-screen overlay stays tabbable (aria-modal covers screen readers only).
