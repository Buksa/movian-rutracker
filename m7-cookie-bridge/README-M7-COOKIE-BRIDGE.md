# RuTracker.org + Movian M7 Cookie Bridge

Авторизация RuTracker.org в **Movian M7 (7.x)** через сессию браузера,
без `webpopup`/WebView и без изменений ядра.

**Версии:** плагин `RuTracker.org 0.9.0` (форк апстримной 0.7.7), расширение
`Movian Cookie Bridge 0.4.0`, Movian-модуль Bridge `1.0.0`
(`vendor/movian-cookie-bridge/`). История — `CHANGELOG.md`.

Человек сам проходит Cloudflare Turnstile и вход **в браузере**; Bridge только
переносит уже существующую сессию (cookies + User-Agent) в Movian. Автоматического
решения капчи нет и не будет.

> Перенос валидной сессии может не сработать: Cloudflare оценивает ещё и IP и
> TLS/HTTP-отпечаток. Живьём на этой машине (Chrome/Orca → M7 на том же ПК) работает.

## Как это устроено

```text
Браузер: rutracker.org (ручные Turnstile + вход)
    ↓ chrome.cookies (оба неймспейса, по domain) + navigator.userAgent
Расширение «Movian Cookie Bridge», профиль RuTracker → «Send to Movian»
    ↓ STPP ws://127.0.0.1:42000/api/stpp   [3, 0, path, value] — loopback (LAN — только по галочке)
M7: settings.apps.nodes.rutracker_bridge.nodes.browserCookie.value
    settings.apps.nodes.rutracker_bridge.nodes.browserUA.value
    ↓ movian-session.js: cookie сразу уходит из дерева настроек в store плагина
    ↓ HTTP-инспектор: cookies только https://rutracker.org|net, UA браузера
Плагин: проверка viewforum.php (вид «вошёл как …») → статус → каталог/поиск/раздача
```

Второй источник сессии — `tools/orca-session-push.js` для встроенного браузера
Orca (его cookie-хранилище расширению не видно). Пишет те же два значения.

ID плагина — `rutracker` (до 0.9.0 был `RuTracker.org`). Группа Bridge
`rutracker_bridge` осталась с тех пор, когда id с точкой нельзя было
адресовать по STPP (пути режутся по `.`, `prop_setdn()` в ядре): все версии
расширения пишут именно туда.

## Структура кода

```text
main.js                         точка входа: связывание слоёв (≈50 строк)
logo.png                        иконка плагина (plugin.json → icon)
src/ui/settings.js              страница настроек «RuTracker.org» → объект config
src/ui/routes.js                маршруты, глобальный поиск, item hook
src/business/catalog.js         главная, разделы, поиск, избранное, раздача → данные
src/business/auth.js            легаси-вход по логину/паролю, капча, выход
src/api/client.js               HTTP: URL, заголовки на каждый запрос, инспекторы, .torrent
src/api/parser.js               HTML → данные (регулярки + gumbo DOM для атрибутов)
src/bridge/rutracker-adapter.js чем RuTracker подтверждает сессию
vendor/movian-cookie-bridge/    универсальная часть Bridge (без знаний о сайтах)
  movian-session.js             Movian-сторона: группа настроек, store, scope, статусы
  bridge-core.js                копия m7-cookie-bridge/extension/lib/bridge-core.js
m7-cookie-bridge/extension/     расширение Chrome/Brave (MV3)
m7-cookie-bridge/tools/         orca-session-push.js, package.sh
tests/, m7-cookie-bridge/tests/ автотесты (node tests/run.js)
```

Зависимости строго в одну сторону: `ui → business → api`; `bridge adapter →
vendor`. `api/client.js` получает сессию Bridge параметром (`client.inspect(bridge)`).

**Почему vendor, а не общий модуль.** `require()` в M7 ищет только в каталоге
плагина и во встроенных модулях Movian (`es_modsearch()`), поэтому общий код
между плагинами возможен лишь копией. Тест падает, если копия ядра разошлась с
канонической. Обновить: `cp m7-cookie-bridge/extension/lib/bridge-core.js vendor/movian-cookie-bridge/`.

**Новый сайт/плагин.** Профиль — одна запись в `bridge-core.js`
(`settingsGroup`, `domains`, `defaultDomain`, `movianRoute`); попап и транспорт
не меняются. Плагин копирует `vendor/movian-cookie-bridge/` и вызывает
`require('./vendor/movian-cookie-bridge/movian-session').create({profile, check, …})`.
Для профиля без фиксированных доменов (HDRezka) плагин передаёт `hosts`, иначе
cookies не отправляются никуда; существующую группу настроек можно передать в
`group`, чтобы не менять пути.

## Установка и обновление

### Плагин

1. Собрать архивы: `m7-cookie-bridge/tools/package.sh` →
   `m7-cookie-bridge/dist/RuTracker.org-0.9.0-m7-bridge.zip` (каталог `dist/`
   в репозиторий не входит).
2. Установить ZIP в Movian как плагин. Для разработки: `movian -p <repo>`
   (внимание: dev-режим включает отладку ядра, см. «Остаточные риски»).
3. С 0.8.0: это новый id (`rutracker`), поэтому Movian ставит его рядом со
   старым `RuTracker.org` — старый удалить, настройки выставить заново,
   сессию Bridge отправить заново. Со старого публичного `rutracker` 0.7.5 —
   обычное обновление (его настройки подхватываются).

### Расширение

1. `chrome://extensions` / `brave://extensions` → Developer mode.
2. **Load unpacked** → `m7-cookie-bridge/extension` (или распаковать
   `dist/movian-cookie-bridge-extension-0.4.0.zip`).
3. При обновлении с 0.3.x — «Reload» на карточке расширения.

### Браузер Orca (Chrome/Brave нет)

```bash
node m7-cookie-bridge/tools/orca-session-push.js --dry-run   # что найдено, без отправки
node m7-cookie-bridge/tools/orca-session-push.js             # отправить в Movian
```

Node.js 22.5+ (`node:sqlite`). Cookie-БД читается только на чтение, печатаются
только имена и количество cookies, UA берётся у самого Orca (`--ua` — вручную),
не-loopback `--stpp` отклоняется. Опции: `--profile`, `--db`, `--stpp`, `--ua`,
`--timeout`, `--dry-run`.

## Использование

1. Movian и браузер на одном устройстве; HTTP-порт Movian в логе (по умолчанию 42000).
2. Попап расширения → профиль **RuTracker** → **Открыть сайт** → вручную
   Turnstile и вход.
3. **Send to Movian**. Попап сообщает только о транспорте и количестве cookies.
4. `rutracker:start` в Movian → строка статуса Cookie Bridge:

| Статус | Что значит | Что делать |
| --- | --- | --- |
| `авторизован как <ник>` | сайт принял сессию на защищённой странице | — |
| `сессия получена, проверяется...` | транспорт прошёл, проверка идёт | подождать |
| `сессия не принята сайтом (истекла или недействительна)` | гостевая страница | войти в браузере заново, Send |
| `требуется проверка Cloudflare в браузере` | 403 challenge (нет/не тот `cf_clearance`, другой UA) | пройти Turnstile в браузере, Send |
| `сетевая ошибка при проверке` | нет ответа / HTTP-ошибка | сеть, домен |
| `сессия не передана` | сессии нет / очищена | Send |

5. Настройки → **RuTracker.org - Cookie Bridge**: «Проверить сессию»,
   «Очистить сессию» (кнопка в попапе делает то же).

Передача ≠ авторизация: расширение сообщает о транспорте, авторизацию
проверяет Movian (одна проверка на одну передачу, без повторов).

Вход по логину/паролю остаётся запасным путём. Успешный вход **заменяет**
сессию Bridge: cookie инспектора иначе перекрывали бы новую сессию из cookie jar ядра.

## Безопасность

**Что делает Bridge**

- Значения cookies нигде не логируются и не показываются (попап, тулза, плагин —
  только количества и имена).
- Cookies уходят только на `https://rutracker.org` / `https://rutracker.net`
  (и поддомены); пользовательский домен/зеркало allow-list не расширяет;
  http не используется. На проверку и страницы плагина UA ставится только
  инспектором (заголовок `User-Agent` в опциях запроса перекрыл бы его —
  `http_header_merge()` в `fa_http.c`).
- В дереве настроек (читается по STPP, виден на экране) остаётся заглушка;
  сессия — в `<storage>/plugins/RuTracker.org…/store/rutracker_bridge`
  **открытым текстом** (как и файл настроек). «Очистить» перезаписывает его
  (store пишется на диск с задержкой до 5 с).
- Плагин не включает трассировку HTTP ядра (`debug: true`).
- Расширение и тулза по умолчанию пишут в STPP только на loopback;
  расширение без установочных прав на все сайты.

**Устройство в сети (Android TV, Fire TV).** STPP не шифрован и не
аутентифицирован, поэтому есть два пути:

1. **Туннель (рекомендуется)** — канал до приставки шифрован, в расширении
   остаётся `127.0.0.1:42000`:

   ```bash
   ssh -N -L 42000:127.0.0.1:42000 user@tv-box      # если на приставке есть sshd
   adb forward tcp:42000 tcp:42000                  # Android по USB-отладке
   ```

   `adb` по Wi-Fi шифрования не даёт — тогда это вариант 2.

2. **Напрямую по локальной сети — осознанный риск.** В попапе галочка
   «Разрешить передачу по локальной сети без шифрования» (по умолчанию
   выключена, запоминается), в тулзе — `--allow-lan`. Тогда host может быть
   адресом локальной сети: `192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`,
   `169.254.x.x` или имя без точки / `.local` / `.lan` / `.home.arpa` /
   `.internal`. Публичные адреса не принимаются и с галочкой. Цена: cookies
   идут по сети **открытым текстом** (их видит любой, кто слушает сеть), а
   Movian принимает запись от любого устройства в сети. Это не защита канала,
   а согласие с риском; попап напоминает об этом после каждой передачи.

### Остаточные риски (ядро M7, плагином не закрываются)

| Риск | Подтверждение | Что сделано / что нужно |
| --- | --- | --- |
| STPP без аутентификации и без проверки Origin; HTTP-сервер слушает все интерфейсы | `stpp.c` (`stpp_init` — только флаг «Allow remote control», по умолчанию вкл.), `http_server.c` (bind any). Живьём: чтение и запись по не-loopback адресу | Cookie не хранится в дереве; запись (подмена/очистка сессии) возможна любым клиентом в LAN и веб-страницей через `ws://127.0.0.1`. Клиент, уже подписанный в момент передачи, видит одно значение. Нужен патч ядра (токен/Origin) или: выключать «Allow remote control» вне передачи, закрыть 42000 файрволом от LAN |
| Лог без аутентификации по HTTP | `httpcontrol.c`: `/api/logfile/<n>` (+ `?mode=pastebin`) | Плагин в лог секретов не пишет (проверено живьём на установленном ZIP) |
| Логирование cookies ядром в debug-режимах | `es_io.c:734` `Inspector setting cookie %s = %s` при `ECMASCRIPT_DEBUG` (`-p`, `"debug"` в plugin.json, dev-настройка ecmascript debug); `fa_http.c` трассирует `Cookie` при «Debug all HTTP requests» | Живьём в `-p`: 5 строк со значениями. **Blocker:** нужна редакция значений в ядре. Не использовать `-p` и dev-отладку с живой сессией; считать такой лог секретом |
| TLS без проверки сертификата | `FA_SSL_VERIFY` только при `verifySSL: true`; CA читаются только из `/etc/ssl/certs` (`net_openssl.c:250`) | Включить в плагине нельзя: на Android/Fire TV все запросы перестали бы работать. Активный MITM видит cookies и пароль. Нужен CA-store в ядре |
| Ядро логирует URL редиректа `torrent:browse:data:…base64` (весь .torrent) | `navigator: Following redirect to …` | Passkey в announce текущих торрентов RuTracker не найден (проверено на одном файле); если трекер начнёт его вшивать, он попадёт в лог |
| Store и settings — открытый текст на диске | `store.js`, `settings.js` | Документировано; шифрования хранилища в M7 нет |
| Cloudflare привязывает `cf_clearance` к UA/IP/отпечатку | живые прогоны | UA передаётся; другой IP (телефон в мобильной сети) → challenge |

## QR Login — исследование (не реализовано)

Желаемый сценарий: Movian показывает QR → телефон → ручной Turnstile/вход →
подтверждение → Movian проверяет сессию.

**Вывод: возможно только с companion-приложением (или Firefox Android с
расширением); обычный сайт не подходит, изменения ядра не требуются.**

- Обычная веб-страница не может прочитать cookies `rutracker.org`
  (same-origin, HttpOnly, partitioned `cf_clearance`). Нужен владелец
  cookie-хранилища: Android-приложение с WebView (`CookieManager` отдаёт и
  HttpOnly) или браузер с расширением (Firefox Android: `cookies` API с
  `partitionKey`; Chrome Android расширения не поддерживает).
- QR в M7: готового генератора нет, но плагин может построить QR на ES5 и
  записать SVG (в ядре есть nanosvg) или BMP в свой storage и показать как
  картинку элемента.
- Канал телефон → M7 без ядра: плагин может открыть свой WebSocket на HTTP-сервере
  Movian (`native/websocket.serverCreate`). Сам канал открытый (`ws://`),
  поэтому полезная нагрузка шифруется ключом из QR (одноразовый 128-битный
  токен, TTL ~5 мин, сжигается после первой попытки, подтверждение на ТВ).
  В Duktape есть только хеши (`native/crypto`), шифрование — проверенной
  ES5-библиотекой (tweetnacl `secretbox`) с обеих сторон. Облачный сервер не нужен.
- Риски: Cloudflare (IP телефона должен совпадать с IP ТВ — одна сеть/NAT;
  UA WebView переносится; отпечаток TLS — не проверено); поддержка CHIPS в
  WebView `CookieManager` — не проверено.
- Минимальный следующий шаг (отдельная ветка `feature/qr-login-feasibility`):
  прототип Android WebView-приложения, которое после входа читает cookies и
  UA, и проверка `bridge.classify()` с этой сессией на ТВ в той же сети —
  до любого кода пейринга.

## Troubleshooting

| Симптом | Что проверить |
| --- | --- |
| Попап: `Movian host должен быть 127.0.0.1…` | По умолчанию только loopback. Для приставки — туннель или галочка «по локальной сети без шифрования» (см. «Безопасность»). |
| Попап: `… Публичные адреса не принимаются` | Host — публичный IP/домен. Допустимы только loopback и адреса локальной сети. |
| Попап: `Домен … не входит в профиль RuTracker` | Профиль RuTracker — только rutracker.org/net. |
| `требуется проверка Cloudflare` | Пройти Turnstile в том же браузере, затем Send. Нужен `cf_clearance` (partitioned) — расширение ≥ 0.3.2 его забирает. |
| `сессия не принята сайтом` | Войти заново в браузере и Send. |
| Разделы/поиск 403, а `index.php` открывается | Норма для Cloudflare: главная не защищена. Статус Bridge с 0.9.0 это показывает. |
| `403 Cf-Mitigated: challenge` при живых cookies | UA должен совпадать с браузерным; статический `User-Agent` в заголовках запроса перекрыл бы его (тест «every RuTracker request carries the bridge User-Agent»). |
| Расширение: `No cookies for …` | Не выполнен вход в этом профиле браузера. Браузер Orca расширению не виден — `tools/orca-session-push.js`. |
| `Cannot connect to ws://…` | Movian запущен? Включён «Allow remote control»? Порт? |
| Повторный Send | С 0.9.0 каждый Send импортируется заново (в настройках заглушка, значение всегда меняется). |

## Тесты

```bash
node tests/run.js                      # всё: ES5, модули, плагин, Bridge
node m7-cookie-bridge/tests/run.js     # только Bridge (ядро, расширение, Orca)
```

Без зависимостей (Node 22.5+). Плагин исполняется целиком в Node под заменой
рантайма Movian (`tests/harness/movian.js` — семантика `require`, инспекторов,
settings, store как в M7) на обезличенных реальных страницах RuTracker
(`tests/fixtures/`, включая настоящий «Just a moment…» Cloudflare). Живую
проверку с Movian и браузером они не заменяют.
