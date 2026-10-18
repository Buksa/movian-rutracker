# RuTracker для Movian M7

Плагин `rutracker` 0.9.0 для [Movian](https://movian.eu) M7: каталог, поиск,
раздачи, `.torrent` и magnet с RuTracker.org. Вход — по логину/паролю или через
**Cookie Bridge**: расширение браузера переносит в Movian уже открытую в
браузере сессию (cookies + User-Agent), поэтому плагин работает за Cloudflare
без WebView. Капчу и Turnstile человек проходит сам, в браузере.

- Установка, использование, безопасность: `m7-cookie-bridge/README-M7-COOKIE-BRIDGE.md`
- История версий: `m7-cookie-bridge/CHANGELOG.md`
- Сборка ZIP плагина и расширения: `m7-cookie-bridge/tools/package.sh`
- Тесты (Node.js 22.5+, без зависимостей): `node tests/run.js`

```text
main.js                точка входа        src/ui/       страницы и настройки
src/business/          каталог, вход      src/api/      HTTP и разбор HTML
src/bridge/            адаптер Bridge     vendor/movian-cookie-bridge/  Bridge для Movian
m7-cookie-bridge/      расширение, инструменты, документация
```

Плагин основан на RuTracker.org 0.7.7 (Wain, fix by kovalDN), GPL-3.0.
