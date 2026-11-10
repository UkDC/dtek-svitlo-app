# Архитектура «Світло» — как всё работает сейчас

Документ описывает **текущее** состояние. История и причины решений — в [`HISTORY.md`](HISTORY.md) (ссылки вида H16). Правила работы — в [`../AGENTS.md`](../AGENTS.md).
Если код и этот документ расходятся — прав код; исправьте документ в том же PR.

Содержание: 1 Продуктовые требования · 2 Потоки данных · 3 Тексты пушей · 4 Карта файлов · 5 Хранилища · 6 Секреты и внешние настройки · 7 Сборка и деплой · 8 Ремонт · 9 Не проверено и открытые вопросы

---

## 1. Продуктовые требования (утверждены владельцем)

- Название строго **«Світло»** (`index.html`, `manifest.webmanifest`, шапка, пуши). Интерфейс на украинском.
- Регионы: Киев `kem` (ДТЕК Київські електромережі, группы `1.1`–`60.2`) и Киевская область `krem` (ДТЕК Київські регіональні, `1.1`–`6.2`).
- Несколько адресов с произвольным названием («Дім», «Дача»); редактирование, удаление. Название — единственное, что от адреса попадает в пуш.
- Группа определяется **автоматически по адресу** (Киев — YASNO, область — сайт ДТЕК); ручная сетка групп — только после неудачи (H6, H8).
- Главный экран (дизайн B «Кільце доби»): кольцо-циферблат, легенда «зі світлом N год / без світла N год», вкладки **только «Сьогодні» и «Завтра»**, список интервалов. **Без таймера обратного отсчёта**, без недели.
- Пуши: ~30 мин до отключения, ~30 мин до включения, при изменении графика; тихие часы (по умолчанию 23:00–07:00). Упреждение **фиксированное** (H9).
- Сортировка улиц и населённых пунктов — по алфавиту без префиксов («вул.», «с.»).
- В установленной PWA на iOS нет pull-to-refresh → обновление: при открытии, каждые 10 мин, при возврате в приложение; строка «Дані ДТЕК від …» — тоже кнопка обновления.

### Кольцо суток (`DayRing`, `ringGeometry.planDial()`)
12-часовой циферблат, 12 сверху, по часовой. Толстое кольцо — текущая половина суток (прошлое приглушено, остаток яркий; в 12:00 и 00:00 перелистывается). Тонкая внешняя дорожка — следующие 12 часов: до полудня — сегодня 12–24, после — **завтра 00–12** (пунктир, если завтра не опубликовано). Реальные 24-часовые цифры внутри кольца и снаружи дорожки (после полудня верхняя — «завтра · 00»), разрыв дорожки на 12 (`TRACK_GAP_MINUTES`). Центр: время, «Світло є / Світла немає», «до HH:MM». Вкладка «Завтра» — без маркера и затемнения. `aria-label` описывает весь день. Почему так — H11.

---

## 2. Потоки данных

### 2.1 Графики в приложении (`src/services/clientScheduleApi.ts` → `fetchAllSchedules`)
Браузер на `ukdc.github.io` не может обращаться к YASNO/ДТЕК напрямую (нет CORS). Поэтому:
1. `./api/schedules` — есть только у локального Express (`server/index.ts`); на Pages падает, это нормально.
2. **Живые зеркала** `Baskerville42/outage-data-ua` (`raw.githubusercontent.com/.../data/kyiv.json`, `kyiv-region.json`, CORS `*`, обновляются сторонним проектом) — основной источник интервалов.
3. **Снимок сервера** `state/combined-schedules.json` из `main` через `raw.githubusercontent.com/UkDC/dtek-svitlo-app/main/...` — свежий (бот коммитит при изменениях). Отсюда берётся флаг `EmergencyShutdowns` (YASNO, Киев) — `carryEmergencyFlag`. Группы, которых нет в живых данных, берутся из снимка.
4. Копия снимка на Pages (`./state/combined-schedules.json`) — **заморожена на момент деплоя**; читается только если `main` недоступен, её флаг экстренности на живые данные не переносится (H16).
5. Кэш в `localStorage` (`svitlo_cached_schedules_v1`) + перенос через полночь (`rolloverBundle`).

Нормализация (`src/services/scheduleNormalizer.ts`): часовые карты DTEK `"1".."24"` (`yes|no|first|second|maybe`) и минутные слоты YASNO → 48 получасовых слотов и склеенные интервалы; `getCurrentAddressStatus` (on/off/emergency/waiting, `targetTime`).

### 2.2 Цикл пушей (GitHub Actions)
```
svitlo-trigger (Cloudflare cron */5) ──workflow_dispatch──► push-check.yml (+ свой schedule */10 как запас)
   npm run push:check → server/cli-push-check.ts → notificationScheduler.runScheduleAndNotificationCheck()
     1. multiSourceClient: outage-data-ua + YASNO planned-outages (Киев) → state/ и public/state/combined-schedules.json
        (не перезаписывается, если отличается только fetchedAt)
     2. подписчики: GET svitlo-subs /internal/subscribers (SUBS_SECRET); упал → workflow красный
     3. для каждого адреса: изменения графика (buildChangeNotification) и окно 10..32 мин (evaluateUpcomingAlerts),
        тихие часы подписчика, журнал дублей notifiedEvents в state/schedule-snapshot.json (ключ на подписчика)
     4. web-push (VAPID) → APNs; 404/410 → POST /internal/remove (мёртвый endpoint)
   коммит state/*.json public/state/ «chore(schedules): … [skip ci]», 4 попытки, иначе ошибка
```
- Окно **10..32 мин** на сервере: при шаге триггера 5 мин каждое событие попадает в окно ≥ 4 раз, журнал оставляет один пуш. В приложении локальная проверка (`App.tsx`, пока PWA открыта) использует **10..42** (обновление раз в 10 мин) и свой журнал `svitlo_notified_events`.
- Отключения/включения через полночь учитываются (передаётся завтрашний день).
- `[skip ci]` значит: коммиты бота **не** запускают деплой (иначе деплой каждые 5 мин).

### 2.3 Определение группы по адресу (`src/components/AddressPage.tsx`)
- **Киев.** Улицы — из локального справочника `public/state/kyiv-streets.json` (3 406 улиц). Дом и группа — Worker `svitlo-address` (прокси к адресному API YASNO: `/streets`, `/houses`, `/group`; `/diag` — диагностика). Запросы с debounce; номера сравниваются терпимо (`normalizeHouseNumber`, H7). Подсказки домов группы не несут — группа запрашивается при выборе.
- **Область.** Населённые пункты — `public/state/oblast-settlements.json` (1 038); улицы — живой поиск Nominatim/Overpass (OpenStreetMap, CORS `*`). Группа — кнопка «Визначити групу» → `src/services/oblastLookup.ts` → Worker `svitlo-lookup` `POST /start` (нужен код-приглашения) → Worker запускает `dtek-lookup.yml` с одним `job_id` → раннер (`scripts/dtek-lookup.ts`) берёт адрес `GET /internal/job` (одноразово), ходит на `dtek-krem.com.ua` через `curl` с cookie, отдаёт `POST /internal/result` → клиент опрашивает `GET /result` до 150 с. Обычно 20–90 с. Неоднозначность → кандидаты (чипы) или «не вдалося», затем ручная сетка.
- Справочники обновляются вручную скриптом `server/fetch-all-streets.ts`.

### 2.4 Подписка на пуши (`src/services/pushSyncService.ts`, Worker `svitlo-subs`)
- Публичный VAPID-ключ — из `./state/vapid-public.json` (кладёт деплой из секрета). Подписка Service Worker'а → `POST svitlo-subs/subscribe` с заголовком `X-Invite` (код-приглашения) → Worker выдаёт **токен устройства** (хранится в `svitlo_device_write_token`, в KV — только хеш). Изменения и `/unsubscribe` — с этим токеном.
- В KV: `sub:<id>` (endpoint, ключи, группы адресов, имена адресов, тихие часы) и индекс `ep:<sha256(endpoint)>`. Улица и дом не отправляются.
- Ссылка `…/#invite=КОД` сохраняет код (`loadInviteCode`) и убирает hash; на iOS см. H17.

### 2.5 Обновление приложения
`public/sw.js`: кэш `CACHE_NAME`, при активации удаляет старые кэши; страницу на `controllerchange` **не** перезагружает (H18) → после релиза PWA нужно полностью закрыть и открыть. Пуш: `showNotification` с иконкой по типу (`icon-off/on/change.svg` — значимо только для десктопа/Android; iOS показывает иконку PWA).

---

## 3. Тексты пушей (`src/services/scheduleNormalizer.ts`)

Правила: украинский; без номера группы; без улицы/дома — только короткое имя адреса (`getShortAddress`: название, иначе населённый пункт); время события первым; заголовок короткий (iPhone через несколько минут режет до ~14–15 знаков после эмодзи, H14); длительность с десятичной запятой (`4,5 год`).

| Тип | Заголовок | Текст | Функция |
| :--- | :--- | :--- | :--- |
| Перед отключением (10..32 мин) | `🪫 16:00 вимкнення` | `Дім · до 20:00 · 4 год без світла` (`до завтра 04:00`, если заканчивается завтра) | `evaluateUpcomingAlerts` |
| Перед включением | `🔋 20:00 увімкнення` | `Дім · до 24:00 · 4 год зі світлом` (период света склеивается через полночь); `Дім · далі можливі відключення`, если дальше «maybe» | `evaluateUpcomingAlerts` |
| Изменение графика | `🗓️ Графік змінено` | `Дім · сьогодні: відключення 16:00–20:00 (було 14:00–18:00)`; `… без відключень (було …)`; `… екстрені відключення`; отмена экстренных → `… (замість екстрених відключень)`; `… графік очікується`; оба дня → строка `Дім`, затем `Сьогодні: …` / `Завтра: …`; ≤ 110 знаков, обрезка «…» | `buildChangeNotification` |
| Первая публикация завтра | `🗓️ Графік на завтра` | `Дім · відключення 14:00–18:00` | `buildChangeNotification` |
| Тестовый | `✅ Сповіщення працюють` | `Попередимо за ~30 хв до відключення та увімкнення.` | `TEST_PUSH_TITLE/BODY` |

Образцы всех типов: `push-check.yml` → Run workflow → `sample_push=true` (уходят **всем** подписчикам).

---

## 4. Карта файлов

| Путь | Роль |
| :--- | :--- |
| `src/main.tsx`, `src/App.tsx` | Вход; состояние адресов/темы/тихих часов, автообновление, локальная проверка пушей, `CURRENT_BUILD_TIMESTAMP` |
| `src/components/DayOverview.tsx` | Главный экран: шапка с адресом, кольцо, легенда, вкладки, список |
| `src/components/DayRing.tsx`, `src/services/ringGeometry.ts` | SVG-циферблат и его чистая геометрия (`planDial`, `RING_PAD`, радиусы) |
| `src/components/ScheduleList.tsx` | Список интервалов, текущая строка «зараз» |
| `src/components/AddressSheet.tsx` | Шторка «Мої адреси» |
| `src/components/AddressPage.tsx` | «Нова адреса»: Київ/область, подсказки, автоопределение, ручная сетка |
| `src/components/NotificationsPage.tsx` | «Сповіщення»: статус, переключатели, тест, «Додатково» (тема, тихие часы, код-приглашения, совет для iOS), «Вимкнути» |
| `src/components/EmptyState.tsx` | Экран без адресов |
| `src/services/scheduleNormalizer.ts` | Парсинг, статусы, окна уведомлений, тихие часы, тексты пушей |
| `src/services/clientScheduleApi.ts` | Загрузка графиков (2.1), поиск улиц/сёл, `lookupHouseGroup` (Київ) |
| `src/services/addressCatalog.ts` | Предзагруженные популярные населённые пункты |
| `src/services/oblastLookup.ts` | Клиент `svitlo-lookup` |
| `src/services/pushSyncService.ts` | Регистрация SW, подписка, синхронизация с `svitlo-subs`, код-приглашения |
| `src/index.css` | Единственная таблица стилей; токены дизайна B заданы **трижды**: `:root` (светлая), `@media (prefers-color-scheme: dark)`, `:root[data-theme='dark']` — меняя токен, правьте все три |
| `server/cli-push-check.ts`, `server/services/notificationScheduler.ts` | Цикл пушей (2.2), VAPID, журнал дублей |
| `server/services/multiSourceClient.ts` | Агрегатор outage-data-ua + YASNO, запись снимка |
| `server/cli-sync-schedules.ts` | Только обновить снимок (используется деплоем) |
| `server/index.ts` | Локальный Express: `/api/schedules`, статика (для прода не используется) |
| `server/fetch-all-streets.ts` | Пересборка справочников улиц/сёл |
| `scripts/dtek-lookup.ts`, `scripts/dtek/lookupCore.ts`, `lookupRun.ts` | Раннер области: HTTP с cookie, парсер ответа ДТЕК |
| `scripts/send-sample-push.ts` | Образцы пушей |
| `scripts/chrome-e2e.ts` | **Устарел** (селекторы до дизайна B), не использовать |
| `cloudflare/trigger/` | `svitlo-trigger`: cron → `workflow_dispatch` push-check |
| `cloudflare/subs/` | `svitlo-subs`: подписки в KV `SUBS` |
| `cloudflare/address/` | `svitlo-address`: прокси YASNO (без секретов) |
| `cloudflare/lookup/` | `svitlo-lookup`: задания области в KV `LOOKUPS` |
| `.github/workflows/push-check.yml` | Цикл пушей; ручные входы `test_push`, `sample_push` |
| `.github/workflows/deploy-pages.yml` | Проверки → сборка → `gh-pages` |
| `.github/workflows/dtek-lookup.yml` | Раннер области (запускает только Worker) |
| `public/sw.js`, `public/manifest.webmanifest`, `public/version.json` | SW, манифест, версия |
| `public/icon-192.svg` + `icon-*-v2.png` | Иконка: SVG — источник, PNG рендерятся из него (H15) |
| `state/combined-schedules.json`, `public/state/combined-schedules.json` | Снимок графиков (пишет бот; в Pages попадает копия из `state/` на момент деплоя) |
| `state/schedule-snapshot.json` | Журнал дублей `notifiedEvents` (хранится 48 ч) и последние изменения |
| `state/` и `public/state/` `kyiv-streets.json`, `oblast-settlements.json` | Справочники |
| `tests/` | Vitest; имена файлов = тестируемые модули |

---

## 5. Хранилища и состояние

| Где | Что | Кто пишет |
| :--- | :--- | :--- |
| `localStorage` телефона | `svitlo_saved_addresses_v1` (адреса с улицей/домом), `svitlo_selected_address_id_v1`, `svitlo_quiet_hours_v1`, `svitlo_theme_v2` (нет ключа = как в системе), `svitlo_cached_schedules_v1`, `svitlo_notified_events`, `svitlo_device_subscriber_id`, `svitlo_device_write_token`, `svitlo_invite_code`; `svitlo_gh_cloud_config_v1` — устаревший, приложение его чистит | приложение |
| Cloudflare KV `SUBS` (`svitlo-subs`) | подписки: `sub:<id>`, `ep:<hash>` | `svitlo-subs` |
| Cloudflare KV `LOOKUPS` (`svitlo-lookup`) | задания и результаты области (TTL 10 мин), суточный счётчик | `svitlo-lookup` |
| git `main`: `state/` | снимок графиков, журнал дублей (**публично**: видны случайные id устройств и адресов, не адреса) | бот push-check |
| ветка `gh-pages` | собранное приложение + копия `state/` + `vapid-public.json` | deploy-pages |

---

## 6. Секреты и внешние настройки (только имена и места — значений нигде нет)

| Где | Имя | Назначение |
| :--- | :--- | :--- |
| GitHub → Settings → Secrets → Actions | `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` | подпись пушей; публичный ещё и публикуется в Pages |
| то же | `SUBS_SECRET` | чтение/чистка подписчиков (= секрет в `svitlo-subs`) |
| то же | `LOOKUP_SECRET` | раннер области ↔ `svitlo-lookup` (= секрет в Worker'е) |
| GitHub → Variables (необязательно) | `LOOKUP_API_URL` | переопределить URL `svitlo-lookup` |
| Worker `svitlo-trigger` | `GITHUB_TOKEN` | fine-grained PAT: только этот репо, только Actions RW; срок ~1 год |
| Worker `svitlo-subs` | `INVITE_CODES`, `SUBS_SECRET` | коды-приглашения через запятую; общий с Actions секрет |
| Worker `svitlo-lookup` | `GITHUB_TOKEN`, `LOOKUP_SECRET`, `INVITE_CODES` | PAT (как выше, ~1 год), общий секрет, те же коды |
| Worker `svitlo-address` | — | секретов нет |
| `cloudflare/*/wrangler.toml` | `REPO`, `WORKFLOW`, `REF`, `DAILY_LIMIT` (40), id KV | несекретные настройки (в git) |

URL Worker'ов (`*.svitlo-b79d27.workers.dev`) прописаны в `src/services/*` и workflow — они публичны, это нормально.
Деплой Worker'а: `cd cloudflare/<имя> && npx wrangler deploy`; секрет: `npx wrangler secret put <ИМЯ>` (или Cloudflare dashboard → Workers → Settings → Variables). Делает владелец.

---

## 7. Сборка и деплой

`deploy-pages.yml` (push в `main` или вручную; коммиты бота с `[skip ci]` его не запускают): `npm ci` → `typecheck` + `test` (красные → не деплоит) → `sync:schedules` → `vite build` → копирует `state/combined-schedules.json`, справочники в `dist/state/` → пишет `vapid-public.json` из секрета (нет секрета → ошибка) → force-push `dist/` в `gh-pages`. Pages раздаёт `gh-pages`.

Релиз — чек-лист в `AGENTS.md` §5.

---

## 8. Ремонт: симптом → где смотреть → что делать

**Пуши перестали приходить всем.**
1. GitHub → Actions → «DTEK Schedule Sync & iOS Web Push Worker»: есть ли запуски каждые ~5 мин? Нет → не работает `svitlo-trigger` (Cloudflare → Workers → `svitlo-trigger` → Logs). Частая причина — истёк PAT `GITHUB_TOKEN` (~1 год): создать новый (только этот репо, Actions: Read and write), `npx wrangler secret put GITHUB_TOKEN`.
2. Запуски красные → открыть лог: «VAPID … not set» — секреты; ошибка чтения подписчиков — `svitlo-subs`/`SUBS_SECRET` (должны совпадать в GitHub и Worker'е); «Could not push state» — гонка коммитов, обычно проходит в следующий раз.
3. Запуски зелёные → `sample_push=true`; если образцы не дошли — проблема подписки на устройстве (ниже).

**Пуши не приходят на одно устройство.** iOS: PWA должна быть установлена с домашнего экрана, уведомления разрешены в Настройках; в «Сповіщення» выключить и включить заново (пересоздаёт подписку). Мёртвые endpoint'ы (404/410) сервер удаляет сам. Тихие часы!

**Дубли пушей.** Проверить, что журнал коммитится (шаг «Commit updated schedule snapshot» в push-check зелёный) и никто не запускал push-логику вне push-check (H4).

**График в приложении устарел / не тот.** Сравнить с `outage-data-ua` (`raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/kyiv.json`) — если там старое, это у источника. Если там свежее, а в приложении нет — строка «Дані ДТЕК від …» (нажать = обновить), кэш `svitlo_cached_schedules_v1`, парсер `parseOutageDataUaBundle` (формат зеркала мог измениться — тесты на реальном образце).

**«Екстрені відключення» висят / не появляются.** Флаг идёт только из `state/combined-schedules.json` в `main` (YASNO, Киев). Посмотреть `today.status` нужной группы там; если в `main` правильно, а в приложении нет — логика `carryEmergencyFlag` (H16).

**Не определяется группа в Киеве.** `https://svitlo-address.svitlo-b79d27.workers.dev/diag` — доступность YASNO; изменился API YASNO → `cloudflare/address/src/handler.ts`; ID улиц YASNO нестабильны — улица проверяется по имени.

**Не определяется группа в области.** Actions → «DTEK lookup»: запускается ли, что в логе (адреса там нет by design). Нет запусков → PAT `svitlo-lookup` (истёк?) или `DAILY_LIMIT`. Лог «blocked»/пустая страница → ДТЕК (Imperva) блокирует раннеры — деградация в ручной выбор, кода не чинит. Изменилась разметка → `scripts/dtek/lookupCore.ts` + фикстуры в `tests/dtekLookup*.test.ts`. Ответ 401 → нет/неверный код-приглашения.

**Сменить код-приглашения.** Cloudflare: `INVITE_CODES` в **обоих** Worker'ах (`svitlo-subs`, `svitlo-lookup`). Уже подписанные устройства продолжают получать пуши; новые регистрации и изменения настроек на устройствах потребуют новый код (ввести в «Додатково»). Код общий для всех, отозвать одного человека нельзя.

**После релиза у пользователя старая версия.** Подняли ли `CACHE_NAME`? PWA полностью закрыть (смахнуть) и открыть. Проверить `https://ukdc.github.io/dtek-svitlo-app/version.json`.

**Не обновляется иконка на iPhone.** Новый суффикс файла (H15), удалить PWA с экрана и добавить заново.

**Деплой красный.** Чаще всего упали `typecheck`/`test` — воспроизвести локально; или нет секрета `VAPID_PUBLIC_KEY`.

---

## 9. Не проверено и открытые вопросы

- Ссылка `#invite=` и установленная PWA на iOS (H17).
- Определение группы области целиком в установленной PWA на устройстве.
- Стиль статус-бара iOS (`default`).
- Игнорирует ли iOS `icon`/`badge` из payload (по сообщениям форумов/WebKit bug 280160 — да; сами не проверяли).
- Остались ли в KV записи без токена устройства (их может «занять» первый, кто зарегистрируется с кодом и тем же id) — не установлено.
- В KV есть второй подписчик неизвестного владельцу происхождения (получает образцы пушей) — выяснить у владельца.
- Сроки PAT в `svitlo-trigger` и `svitlo-lookup` (~1 год с ноября 2026) — поставить напоминание.
- `scripts/chrome-e2e.ts` устарел; тестов компонентов нет — UI проверяется скриншотами вручную.
- Страница под полноэкранным оверлеем доступна по Tab (только `aria-modal`).
