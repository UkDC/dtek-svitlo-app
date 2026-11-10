# AGENTS.md — точка входа для ИИ-агентов и разработчиков

Этот файл агент читает первым. Здесь коротко описано, что это за проект, как он устроен, как вносить изменения и чего делать нельзя.
Подробности — в двух документах:

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — как всё работает **сейчас**: компоненты, потоки данных, файлы, секреты, тексты пушей, ремонтные инструкции («симптом → где смотреть → что делать»), что не проверено.
- [`docs/HISTORY.md`](docs/HISTORY.md) — журнал проблем: что ломалось, почему, как исправили и какое правило из этого вышло. Прочтите его, прежде чем «упрощать» что-то странное: странность там почти всегда объяснена.

Язык: документы на русском, идентификаторы — как в коде, интерфейс и тексты пушей — **украинские**, их цитируем дословно.

---

## 1. Что это

«Світло» — PWA для iPhone (iOS 18.7+, установка «На экран Домой») и любого браузера. Показывает графики отключений ДТЭК для **Киева** (`kem`, группы 1.1–60.2) и **Киевской области** (`krem`, 1.1–6.2) и присылает Web Push: за ~30 мин до отключения, за ~30 мин до включения, при изменении графика. Пользователи — владелец и несколько знакомых (вход по коду-приглашению), публичного сервиса нет.

- Репозиторий: `UkDC/dtek-svitlo-app` (**публичный** — всё, что закоммичено, видят все).
- Прод: https://ukdc.github.io/dtek-svitlo-app/ (ветка `gh-pages`, собирается из `main`).
- Текущая версия — только в `public/version.json` (в прозе её не дублируем).

## 2. Как устроено (за минуту)

```
Браузер/PWA (React+Vite, src/)                      GitHub Actions (server/, scripts/)
 ├─ графики: outage-data-ua (raw GitHub, CORS *)     push-check.yml  ← svitlo-trigger (Cloudflare cron, каждые 5 мин)
 │          + снимок state/combined-schedules.json    ├─ тянет outage-data-ua + YASNO → state/combined-schedules.json
 │            из main (raw) — флаг «екстрені»         ├─ читает подписчиков из svitlo-subs (KV, SUBS_SECRET)
 ├─ группа по адресу: Київ → svitlo-address (YASNO)   ├─ шлёт Web Push (VAPID) → Apple APNs → iPhone (public/sw.js)
 │                    область → svitlo-lookup ─┐      └─ коммитит снимок + журнал дублей [skip ci]
 └─ подписка на пуши → svitlo-subs (код-приглашение)  dtek-lookup.yml ← svitlo-lookup: раннер ходит на dtek-krem.com.ua
                                                 └──→ (Cloudflare там заблокирован, раннер — нет)
```

Хранилища: подписки — только в приватном Cloudflare KV (не в git); адреса пользователей (улица/дом) — только в `localStorage` телефона; снимок графиков и журнал дублей — в git (`state/`).

## 3. Где что лежит

| Путь | Что там |
| :--- | :--- |
| `src/App.tsx` | Корень UI, состояние, автообновление, локальная проверка уведомлений, `CURRENT_BUILD_TIMESTAMP` |
| `src/components/` | Экраны дизайна B: `DayOverview`/`DayRing` (кольцо суток), `ScheduleList`, `AddressPage`, `AddressSheet`, `NotificationsPage`, `EmptyState` |
| `src/services/` | Логика: `scheduleNormalizer` (парсинг, статусы, тексты пушей), `clientScheduleApi` (загрузка графиков, поиск адресов), `pushSyncService`, `oblastLookup`, `ringGeometry` |
| `server/` | Код для GitHub Actions: `cli-push-check.ts`, `cli-sync-schedules.ts`, `services/notificationScheduler.ts`, `services/multiSourceClient.ts`; `index.ts` — Express **только для локальной разработки** |
| `scripts/` | `dtek-lookup.ts` (+`dtek/`) — раннер области; `send-sample-push.ts` — образцы пушей; `chrome-e2e.ts` — **устарел** |
| `cloudflare/{trigger,subs,address,lookup}` | Четыре Worker'а (деплоит владелец через `wrangler`) |
| `public/` | `sw.js` (Service Worker), `manifest.webmanifest`, иконки, `version.json`, справочники улиц/сёл |
| `state/` | `combined-schedules.json` (снимок графиков, пишет бот), `schedule-snapshot.json` (журнал дублей), справочники |
| `tests/` | Vitest: сервисы, Worker'ы, сервер (тестов компонентов нет) |

Полная карта — `docs/ARCHITECTURE.md` §4.

## 4. Команды

```bash
npm ci
npm run typecheck      # tsc --noEmit (гейт в deploy)
npm test               # vitest run (гейт в deploy) — всё должно быть зелёным
npm run build          # vite build → dist/
npm run dev:client     # vite dev-сервер (UI; графики придут с live-зеркал)
```

`npm run push:check` / `sync:schedules` локально ходят в сеть и требуют VAPID-ключей (без них генерируются временные в git-игнорируемый `state/vapid-keys.json`); боевые пуши шлёт только Actions.

## 5. Как вносить изменения

1. **Ветка.** Работайте в выданной ветке. Если её прошлый PR уже влит — пересоздайте её от свежего `main`:
   `git fetch origin main && git checkout -B <ветка> origin/main && git merge -s ours origin/<ветка>` и обычный `git push -u origin <ветка>` (force-push может быть запрещён; `merge -s ours` делает обычный push возможным, не перетаскивая старый код).
2. **Проверка перед push:** `npm run typecheck && npm test && npm run build`. Меняли UI — посмотрите скриншоты (Playwright, 390 px и 320 px, светлая и тёмная темы).
3. **PR** в `main`. **Вливать — только после явного «да» владельца на вопрос о слиянии.** Одобрение задачи ≠ одобрение слияния.
4. После слияния `deploy-pages.yml` собирает и публикует `gh-pages` (~1–2 мин). Проверьте, что прогон зелёный и `gh-pages/version.json` обновился. Владельцу: полностью закрыть и открыть PWA (новый кэш SW).

### Чек-лист релиза (любое изменение того, что видит пользователь)
- `public/sw.js` → `CACHE_NAME = 'svitlo-pwa-vX-Y-Z'` (иначе установленная PWA покажет старое).
- `public/version.json` → `version` и `buildTime`.
- `src/App.tsx` → `CURRENT_BUILD_TIMESTAMP` **равен** `buildTime` и строго позже предыдущего.
- `docs/ARCHITECTURE.md` — если поменялось поведение; `docs/HISTORY.md` — если чинили проблему.
Чисто документационные изменения версию не поднимают.

## 6. Жёсткие правила (у каждого есть причина — ссылки на журнал)

- **Никаких секретов в репозитории**: ни VAPID, ни токенов, ни кода-приглашения, ни адресов пользователей, ни push-endpoint'ов. Репо публичное. → [HISTORY H1, H2](docs/HISTORY.md)
- **Не угадывать группу.** Нет надёжного ответа источника → «не удалось определить» + ручной выбор как запас. → H6
- **Не рисовать UI, который бэкенд не выполняет.** Упреждение фиксированное — 30 мин (серверное окно 10..32 мин); выбора 15 мин / 1 час нет. → H9
- **Тексты пушей** (`src/services/scheduleNormalizer.ts`): украинский; время события первым в заголовке; без номера группы; без улицы/дома (только короткое имя адреса); заголовок короткий (iPhone режет ~14–15 знаков после эмодзи). Меняете текст — обновите тесты `tests/changeNotification.test.ts` и др. → H12–H14
- **Иконки**: при смене не перезаписывать файл, а менять суффикс (`-v2` → `-v3`) и все ссылки на него — iOS кэширует по URL. → H15
- **Флаг «екстрені відключення»** переносить на живые данные только из свежего снимка `main`, не из копии Pages. → H16
- **Снимок графиков бот коммитит с `[skip ci]`** — это значит, что копия на Pages обновляется только при деплое. Не полагайтесь на неё как на свежую. → H16
- **Не трогать журнал дублей** `state/schedule-snapshot.json` руками и не запускать push-логику из deploy — будут дубли или пропуски. → H4
- В публичных логах/inputs workflow не должно быть адресов (поэтому `dtek-lookup.yml` получает только `job_id`). → H8

## 7. Чего агент сделать не может (это работа владельца)

- У агента **нет секретов**: `VAPID_*`, `SUBS_SECRET`, `LOOKUP_SECRET`, `INVITE_CODES`, GitHub PAT'ы в Worker'ах.
- Деплой и настройка Cloudflare Worker'ов (`wrangler deploy`, `wrangler secret put`), ротация секретов, отзыв токенов.
- Проверка на реальном iPhone. Агент может отправить образцы пушей: `push-check.yml` → Run workflow → `sample_push=true` (уходят **всем** подписчикам — спрашивайте владельца).

Где что настраивать и как чинить — `docs/ARCHITECTURE.md` §6 (секреты) и §8 (ремонт).
