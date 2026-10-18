# Movian Cookie Bridge (extension) 0.4.0

Unpacked Chrome/Brave extension (Manifest V3) that copies a site session —
cookies and User-Agent — from the browser into a Movian plugin over STPP.
Profiles are isolated; each writes only its own settings group:

| Profile | Domains it may export | Movian settings group |
| --- | --- | --- |
| **HDRezka** | any (user-named mirror, granted per site) | `HDRezka` |
| **RuTracker** | `rutracker.org`, `rutracker.net` | `rutracker_bridge` |

Profiles are entries in `lib/bridge-core.js` (`settingsGroup`, `domains`,
`defaultDomain`, `movianRoute`); the popup builds its list from there and the
STPP paths derive from the group. The same file is the canonical core for
`../tools/orca-session-push.js` and, as a vendored copy, for Movian plugins
(`vendor/movian-cookie-bridge/` at the repository root).

## Install

1. `chrome://extensions` or `brave://extensions` → Developer mode.
2. **Load unpacked** → this directory.

## Use

1. Run Movian **on the same machine** (default HTTP port 42000).
2. Pick a profile, **Открыть сайт**, pass Cloudflare and log in by hand.
3. **Send to Movian**. The status reports transport and the cookie count —
   never values. Whether the site accepted the session is checked by Movian.

**Очистить сессию** writes empty values for the active profile.

## Security

- Movian host is loopback (`127.0.0.1`, `localhost`) by default: STPP is
  unauthenticated plaintext `ws://` and Movian listens on every interface.
  For a TV box, prefer an encrypted tunnel ending on this machine
  (`ssh -N -L 42000:127.0.0.1:42000 user@box`, `adb forward tcp:42000 tcp:42000`)
  and keep `127.0.0.1` here.
- Or tick «Разрешить передачу по локальной сети без шифрования» (off by
  default, remembered): then a local-network host is accepted — private IPv4
  (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`, `169.254.x.x`) or a local name
  (no dot, `.local`, `.lan`, `.home.arpa`, `.internal`). Public addresses are
  refused regardless. This is an accepted risk, not a protected channel: the
  cookies cross the network in clear text and Movian takes writes from
  anyone on it. The CSP allows `http://*:*`/`ws://*:*` because it cannot
  express "private networks"; `BridgeCore.movianHostAllowed()` enforces it.
- Cookies are read for the profile site only, by `domain` (path-scoped
  session cookies would be missed by `url`), from both the unpartitioned and
  the partitioned (CHIPS) namespace — Cloudflare's `cf_clearance` is
  partitioned. One value per name: partitioned wins, then the longest path.
- Values are never logged, stored in `chrome.storage` or rendered.

## Permissions

`cookies`, `storage`, `webRequest`; host permissions for the profile sites
(https **and** http: `chrome.cookies` only returns a cookie without the Secure
flag when the extension may access the site's http origin — RuTracker's
`bb_guid`/`bb_ssl`/`bb_t` are such cookies; nothing is sent over http) and
loopback. `http://*/*` and `https://*/*` are **optional**: the request log
(HDRezka playback diagnostics, stream/CDN hosts unknown in advance) asks for
them via «Захватывать запросы ко всем сайтам». Without them the log covers the
profile sites. Secret headers (`Cookie`, `Authorization`, `Set-Cookie`,
`Proxy-Authorization`) are stored as `[present]`. A HDRezka mirror not listed
in the manifest is granted by Chrome's own prompt on the first Send.
