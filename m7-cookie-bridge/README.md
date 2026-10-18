# Movian Cookie Bridge — RuTracker для Movian M7

Компонент Cookie Bridge: перенос сессии браузера (cookies + User-Agent) в
Movian M7, чтобы плагин работал за Cloudflare без WebView. Сам плагин
`rutracker` 0.9.0 лежит в корне репозитория (`plugin.json`, `main.js`, `src/`,
`vendor/`).

**Начать отсюда:** `README-M7-COOKIE-BRIDGE.md` — устройство, установка,
безопасность, остаточные риски, исследование QR Login.

| Путь | Что |
| --- | --- |
| `README-M7-COOKIE-BRIDGE.md` | Основной документ |
| `CHANGELOG.md` | История плагина и расширения |
| `extension/` | Расширение Chrome/Brave 0.4.0 (MV3); `lib/bridge-core.js` — каноническое ядро Bridge |
| `tools/orca-session-push.js` | Перенос сессии из встроенного браузера Orca |
| `tools/package.sh` | Сборка `dist/` (ZIP плагина и расширения; `dist/` в `.gitignore`) |
| `tests/run.js` | Тесты ядра, расширения и Orca-тулзы (`node tests/run.js` в корне запускает всё) |

Сессионные cookies — учётные данные: значения не логируются и не
показываются; в тестах только обезличенные страницы и вымышленные значения.
