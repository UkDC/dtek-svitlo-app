# План реализации и техническая спецификация: iPhone-приложение «Світло» (PWA + GitHub Cloud)

> Этот документ предназначен для разработчиков и ИИ-моделей (LLM / кодирующих агентов), продолжающих работу над проектом **«Світло»** (`UkDC/dtek-svitlo-app`). Здесь зафиксированы все требования пользователя, архитектурные решения, структура данных и особенности внешних API.

---

## 1. Описание задачи и пользовательские требования
Разработать и поддерживать быстрое, удобное и эстетичное приложение для **iPhone (Progressive Web App для iOS 18.7+)** под названием **«Світло»**, работающее через **GitHub (`https://github.com/UkDC/dtek-svitlo-app`)** и опубликованное на **GitHub Pages (`https://ukdc.github.io/dtek-svitlo-app/`)**, для отслеживания актуальных графиков отключений электроэнергии в Украине:
- **ДТЭК Киевские электросети (г. Киев)**: `https://www.dtek-kem.com.ua/ua/shutdowns` (сетка `1.1` – `60.2`, 60 подгрупп)
- **ДТЭК Киевские региональные электросети (Киевская область)**: `https://www.dtek-krem.com.ua/ua/shutdowns` (сетка `1.1` – `6.2`, 12 подгрупп)

### Ключевые продуктовые требования (утверждены пользователем):
1. **Название приложения**: Строго **«Світло»** (в шапке, `index.html`, `manifest.webmanifest`, уведомлениях).
2. **Управление адресами и автодополнение**:
   - Возможность добавлять несколько адресов и **самостоятельно устанавливать любое произвольное название** (`label`: например, «Моя квартира», «Офис», «Родители», «Дача») и иконку (`emoji`), а также переименовывать, редактировать или удалять любой адрес.
   - Полноценные **интерактивные выпадающие списки с подсказками (Autocomplete Dropdowns)** для полей:
     - **Населённый пункт (Киевская область)**: база из **1 038 населённых пунктов** Киевской области (`public/state/oblast-settlements.json`) + живой поиск через Nominatim API (`CORS *`), включая все районные варианты одноимённых сёл (например, `с. Гатне`).
     - **Улица**: база из **3 406 улиц г. Киева** (`public/state/kyiv-streets.json`, совмещённая из YASNO API v2 и OpenStreetMap Overpass API `UA-30`) и динамическая подгрузка всех улиц любого села/города Киевской области через Overpass API (`UA-32`, `CORS *`) + Nominatim.
     - **Дом**: выпадающий список номеров домов с автоматическим определением группы ДТЭК (по базе YASNO API v2 / встроенному справочнику) и возможностью ручного выбора/переопределения любой группы (`1.1`–`60.2` для Киева, `1.1`–`6.2` для Области).
3. **Экран статуса и графиков**:
   - **БЕЗ таймера обратного отсчёта** на главной карточке — только чёткий текущий статус («Свет есть», «Отключение по графику», «Экстренные отключения») и время текущего/следующего слота.
   - **БЕЗ вкладки «Неделя»** — только две оперативные вкладки: **«Сегодня»** и **«Завтра»**.
   - Наглядная 24-часовая шкала суток из **48 получасовых слотов** (`00:00` – `24:00`), маркер текущего времени по Киеву (`Europe/Kyiv`), карточки интервалов (`00:00 – 06:30`), почасовая сетка, подсчёт часов со светом и без света за сутки.
   - Баннер **«⚡ График обновлён в течение дня»** при изменении слотов ДТЭК.
4. **Push-уведомления (iOS 18.7+ Web Push)**:
   - За **~30 минут до начала отключения** света.
   - За **~30 минут до включения** света (восстановления электроснабжения).
   - Мгновенно при **изменении графика в течение дня** или введении экстренных отключений.
   - Настройка **«Тихие ночные часы»** (по умолчанию `23:00 – 07:00`).

---

## 2. Ключевые архитектурные и технические решения

### 2.1. Обход ограничений CORS на GitHub Pages + Тройной каскад источников расписаний
На статическом хостинге GitHub Pages (`Origin: https://ukdc.github.io`) прямые браузерные запросы к `app.yasno.ua` и `dtek-kem.com.ua` блокируются из-за отсутствия заголовка `Access-Control-Allow-Origin`. Поэтому реализована двухконтурная схема:
- **В браузере на iPhone (`src/services/clientScheduleApi.ts`)**:
  1. Прямой fetch из оперативного зеркала `Baskerville42/outage-data-ua` (`https://raw.githubusercontent.com/Baskerville42/outage-data-ua/main/data/{kyiv,kyiv-region}.json`), которое отдаёт `Access-Control-Allow-Origin: *` и обновляется каждые 5 минут.
  2. Чтение агрегированного слепка `./state/combined-schedules.json` со всеми 72 группами (`60` групп Киева + `12` групп Области), публикуемого воркером GitHub Actions.
- **На сервере / в GitHub Actions (`server/services/multiSourceClient.ts`)**:
  - Node.js воркер опрашивает напрямую `YASNO API v2` (`https://app.yasno.ua/api/blackout-service/public/shutdowns/regions/25/dsos/902/planned-outages`) + `outage-data-ua` + `dtek-kem/krem`, сверяет статусы экстренных отключений (`EmergencyShutdowns`) и метки времени `updatedOn`, и сохраняет свежий слепок в `state/combined-schedules.json` и `public/state/combined-schedules.json`.

### 2.2. Справочники адресов и внешние API поиска улиц/домов
- **Локальные полные каталоги в репозитории (`public/state/` и `state/`)**:
  - `kyiv-streets.json`: **3 406 улиц Киева** (`[{ id, name }]`), собранных из YASNO API v2 и OpenStreetMap Overpass API (`ISO3166-2=UA-30`).
  - `oblast-settlements.json`: **1 038 населённых пунктов Киевской области**, собранных из OpenStreetMap Overpass API (`ISO3166-2=UA-32`).
- **Точные эндпоинты YASNO API v2 для адресного поиска по Киеву (для серверных скриптов)**:
  - Базовый URL: `https://app.yasno.ua/api/blackout-service/public/shutdowns/addresses/v2`
  - Улицы: `GET /streets?regionId=25&dsoId=902&query=<мин_2_символа>` → `[{ id: 1094, value: "вул. Хрещатик" }]`
  - Дома: `GET /houses?regionId=25&dsoId=902&streetId=803&query=<номер>` → `[{ id, value }]`
  - Группа ДТЭК по дому: `GET /group?regionId=25&dsoId=902&streetId=803&houseId=<id>` → `{ group: 36, subgroup: 1 }`
- **Живой поиск улиц в сёлах Киевской области прямо из браузера (`CORS *`)**:
  - При выборе любого села (например, `с. Гатне`) клиент запрашивает все улицы этого населённого пункта через `https://overpass-api.de/api/interpreter` и `https://nominatim.openstreetmap.org/search` (оба отдают `Access-Control-Allow-Origin: *`) и кэширует их в памяти.

### 2.3. Скользящее окно уведомлений `[10..42]` минут и дедупликация
Поскольку cron в GitHub Actions запускается с шагом 5–15 минут, строгая проверка `осталось ровно 30 минут` привела бы к пропуску уведомления.
Функция `evaluateUpcomingAlert` в `src/services/scheduleNormalizer.ts` проверяет окно `[10..42]` минут до начала слота отключения или включения и записывает ключ `"${addressId}:${dateKyiv}:${eventType}:${slotStartMinutes}"` в `state/schedule-snapshot.json` (`notifiedEvents`), гарантируя ровно 1 уведомление без дублей и без пропусков.

---

## 3. Карта файлов репозитория

- `src/services/scheduleNormalizer.ts` — ядро нормализации (конвертация часовых карт `DTEK fact` `"1".."24"` со значениями `"yes"|"no"|"first"|"second"` и минутных слотов `YASNO` в 48 получасовых слотов и склеенные интервалы; `computeScheduleDiff`; `evaluateUpcomingAlert`; `isWithinQuietHours`).
- `src/services/addressCatalog.ts` — предзагруженные справочники популярных населённых пунктов области, справочник улиц Киева для подсказок (группа ДТЭК НЕ угадывается: без проверенных данных пользователь выбирает её вручную), иконки адресов.
- `src/services/clientScheduleApi.ts` — клиентский сервис загрузки расписаний, нечёткого русско-украинского поиска (`normalizeSearchTokens`, `matchesTokens`) по 3 406 улицам Киева и 1 038 населённым пунктам области, интеграции с Overpass/Nominatim.
- `src/services/pushSyncService.ts` — регистрация Service Worker, подписка на Web Push (VAPID) и безопасная синхронизация с бэкендом или GitHub API (`localStorage` токен никогда не попадает в git).
- `src/components/AddressSwitcher.tsx` — горизонтальная панель карточек сохранённых адресов с кастомными названиями.
- `src/components/HeroStatusCard.tsx` — главная карточка текущего статуса (без таймера обратного отсчёта).
- `src/components/ScheduleView.tsx` — вкладки «Сегодня» / «Завтра», 48-слотовая шкала, почасовая сетка и список интервалов.
- `src/components/AddressModal.tsx` — модальное окно добавления/редактирования адреса с выпадающими списками подсказок (`autocomplete-dropdown`) для населённого пункта, улицы и дома.
- `src/components/NotificationSettingsModal.tsx` — модальное окно настроек Web Push, тихих часов и синхронизации с GitHub Cloud.
- `server/services/multiSourceClient.ts` — серверный агрегатор `outage-data-ua` + `YASNO API v2`.
- `server/services/notificationScheduler.ts` & `server/cli-push-check.ts` — планировщик и CLI-воркер рассылки Web Push уведомлений.
- `server/fetch-all-streets.ts` — скрипт обновления полного справочника улиц Киева и населённых пунктов Киевской области.
- `.github/workflows/deploy-pages.yml` — автосборка Vite PWA, копирование `state/*.json` в `dist/state/` и публикация в ветку `gh-pages`.
- `.github/workflows/push-check.yml` — периодический запуск `npm run push:check` каждые 5 минут для обновления графиков и отправки Web Push.
- `tests/scheduleNormalizer.test.ts` — модульные тесты Vitest (6 тестов).

---

## 4. Команды для проверки и сборки
```bash
npm install
npm test             # Запуск unit-тестов Vitest (tests/scheduleNormalizer.test.ts)
npm run push:check   # Синхронизация свежих графиков ДТЭК/YASNO и отправка Web Push
npm run build        # Сборка фронтенда в dist/
npm start            # Запуск локального Express/Node сервера на порту 3000
```
