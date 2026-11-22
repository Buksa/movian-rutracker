# Development testing and live E2E policy

This is the canonical development policy for Movian M7, Movian Go and the
RuTracker plugin. It separates local development diagnostics from release
requirements. Development is observable and reproducible; release artifacts
must not contain local credentials, profiles or unredacted traces.

## Development mode
The wrappers use an installed ZIP by default. For source-tree iteration, pass
`MOVIAN_ARGS="-p <plugin-dir>"` to M7 or `MGO_ARGS="-p <plugin-dir>"` to MGO.
Use a private profile because `-p` development mode may log cookies.

The following are allowed in a private local development run:

- Movian Go `-d`, plugin `-p <plugin-directory>`, verbose JS/HTTP/CEF/GLW/Core
  logging, and HTTP request/response traces, including headers and status.
- Locally prepared Keyring credentials, persistent development profiles and
  real RuTracker authentication tests.
- Inspecting Core Jar cookie names, attributes, expiry and persistence.
- Testing both installed ZIP and `-p` plugin modes. Use the least expensive
  mode that exercises the changed path; a ZIP is not required for every JS
  change.

These are development options, not production defaults. Do not change
production logging defaults merely to simplify local debugging.

## Diagnostics and secrets

- Useful metadata includes URL, method, status, redirects, challenge
  classification, cookie names/attributes, User-Agent, session source/state,
  CEF lifecycle and `waitForCookie` events, refresh/retry decisions, Core Jar
  persistence/expiry, navigation routes and pagination/cursors.
- Agent-readable logs, reports, patches, chat and CI output MUST redact
  passwords, credential POST fields, `cf_clearance`, `bb_session`,
  Authorization headers and other authentication tokens. Cookie names and
  attributes MAY be reported.
- `-p` and raw HTTP/debug traces may contain authentication values. When raw
  wire-level details are needed, keep them only in a designated private local
  directory with restrictive permissions and limited retention. Do not paste
  or expose raw lines to the agent/report.
- Do not stop a live test merely because verbose diagnostics are enabled;
  contain a specific exposure instead.
- No CAPTCHA automation. If the challenge requires an interactive check, stop
  automation and ask the owner to complete that step.

## HTTP Control

HTTP Control is allowed for development and automation. Prefer localhost-only
binding. Always inspect the actual listening socket with `ss`; do not infer
scope from a launch flag. If the service cannot bind only to localhost, use a
verified firewall rule or isolated local network namespace before using it.
Never expose unauthenticated control or raw logs to the LAN or Internet.

For Movian Go, `mgo-start.sh` leaves Core HTTP control on, as the app
starts it (42000, or a free port when 42000 is taken), on all interfaces.
This is a deliberate dev-only choice; `ss -ltnp` shows the port.

## Profiles and analytics

- Persistent development profiles are allowed and RECOMMENDED for restart,
  Core Jar and expiry tests. Local preseed files may include
  `tools/preseed/persistent/settings/keyring` and `settings/dev`; never print
  them, package them or add them to Git.
- Use mode `0600` for preseed files and `0700` for profile directories. Keep
  the profile across restarts and until the relevant session tests finish.
  Both stop scripts preserve profiles by default. For an immediate MGO
  restart use `mgo-stop.sh --keep`; pass `--wipe` only for explicit final
  cleanup after the profile has been scanned/reviewed.
- Keep credentials, cookies, profiles and raw traces out of plugin ZIPs and
  repository changes. `tools/preseed/` stays ignored.
- Disable analytics for isolated automated/live tests where possible. Its
  setting MUST NOT block local compilation or unit tests. Never send traces
  containing authentication secrets to analytics.

## Leakscan and release checks

Leakscan is advisory during local development. A failed, unavailable or
inconclusive CEF database scan is not by itself evidence of a leak and is not
a blocker; record the limitation and continue with other checks.

Run it as `node tools/live/leakscan.js [--db <Cookies> | --values <file> | --store <file>] <dir|file>...`:
it prints each file with the cookie names found in it, never a value, and exits 1
when a value turns up outside the Session Coordinator's store. Scan the run's
profile and cache, and scan with `--store` before `mgo-stop.sh --wipe`.

Before commit or push, inspect staged files for credentials, cookies, Keyring
material, profiles and raw traces. Actual secrets MUST NOT be published;
keep local profiles and `tools/preseed/` excluded. Release checks may impose
stricter logging, packaging and validation requirements than this development
policy.

## Release mode

Release builds use production logging defaults: no development `-d`/`-p`,
`debug: true`, raw HTTP/CEF traces or local credentials. Inspect the exact
staged files and packaged ZIP; exclude Keyring material, cookies, profiles,
preseed files and private logs. Block publication of actual secrets. A
leakscan result is evidence, not a substitute for inspecting the package.

## E2E priorities

Prioritize repeatable real tests in this order:

1. Clearance acquisition through CEF.
2. Automatic popup completion.
3. Password Login with the clearance pair.
4. Cloudflare refresh without password.
5. Authenticated forum, tracker and torrent access.
6. Restart and persistence.
7. Expired-session recovery.
8. Error handling and fallback behavior.

## Tools

Installed: `Xvfb`, `xdotool`, `xwininfo`, `xdpyinfo`, `ffmpeg` (with
`x11grab`). Not installed: `xwd`, ImageMagick (`import`, `convert`),
Pillow. Screenshots therefore go through `ffmpeg`.

## Start and stop

Movian M7 (`tools/live/start.sh` uses `-d` and enables its control API):

```sh
export MOVIAN_DIR=<Movian Public Fork checkout> LIVE_DIR=<private scratch dir>
tools/live/start.sh
ss -ltnpH                          # verify the actual M7 listener address
tools/live/stop.sh                 # stops Movian/Xvfb, preserves the profile
tools/live/stop.sh --wipe          # explicit cleanup after E2E is complete
```

If M7 binds beyond localhost, restrict it with a verified firewall rule or
isolated network before using HTTP Control. The default start script does not
itself provide a firewall.

Movian Go (CEF build):

```sh
export MGO_DIR=<movian-go tree with runtime> MGO_BIN=<new build> LIVE_DIR=<private scratch dir>
# For an existing desktop X11 session, set MGO_DISPLAY="${DISPLAY:?}"; omit it to use Xvfb.
tools/live/mgo-start.sh [plugin.zip] [start-url]
ss -ltnpH                          # which port Core HTTP took
tools/live/mgo-stop.sh             # stop runtime, preserve profile
tools/live/mgo-stop.sh --keep      # stop MGO only; retain Xvfb for immediate restart
tools/live/mgo-stop.sh --wipe      # explicit profile cleanup after E2E
```
Live stop scripts require their run marker and recorded PID. Do not stop or
kill Movian instances that were not started by the matching script; avoid
`pkill`/`pgrep` process-name matching.

`mgo-start.sh` installs the ZIP, disables analytics in the isolated profile,
accepts the plugin terms and waits for the window. It preserves existing
Core Jar state in the same `LIVE_DIR`; use the same directory for restart
and expiry tests.

For a credentialed private E2E, `MGO_PRESEED` may point to local files at
`persistent/settings/keyring` and `persistent/settings/dev`. The script copies
those with mode `0600`, forces analytics off in the temporary copy and never
packages the preseed. It does not expose their contents.

`dist/cefrt` is CEF's `Release` directory merged with `Resources`
(`scripts/fetch_cef.sh linux64`, then build with `PKG_CONFIG_PATH=$PWD/third_party/cef/linux64 make build`).

Pick `MGO_BIN` by what it supports, not by worktree name: builds in
`rutracker-*` worktrees have lacked the popup functions the plugin uses.
A usable build passes both checks:

```sh
grep -ac 'webcookies\|persistWebCookie' "$MGO_BIN"                     # non-zero
ldd "$MGO_BIN" | grep -c libcef                                       # CEF build
```

## Android

Movian Go (debug APK, `com.moviango.mediaplayer`): `adb forward
tcp:<free> tcp:42000` reaches HTTP Control and `/api/stpp`; install the ZIP
with `curl -X POST -H 'Content-Type: application/zip' --data-binary
@plugin.zip http://127.0.0.1:<free>/api/plugin/install`. `run-as
com.moviango.mediaplayer` reads the profile (`files/settings/httpcookies`;
report names and lengths only).

Movian M7 (`com.deanbg.movian` 7.0.281): not debuggable, so `run-as`
fails, and its STPP answers 403, so no Cookie Bridge push. Install the
plugin by serving the ZIP on the PC, `adb reverse tcp:<port> tcp:<port>`,
then `/api/open?url=http://127.0.0.1:<port>/plugin.zip` through the
forwarded HTTP Control. Test sign-in with Password Login. Record whether
the plugin was installed before; remove it afterwards unless the owner
keeps it. Remove every `adb forward`/`adb reverse` you added.

## Seeing the screen

```sh
tools/live/shot.sh login        # -> $LIVE_DIR/shots/login.png
```

Open the PNG with the Read tool. The screen is 1280×720, the size of the
Movian window, so image coordinates are click coordinates. With
`MGO_DISPLAY` (e.g. the WSLg desktop, whose root window reads back black)
`shot.sh` shoots the Movian Go window itself: click with
`xdotool mousemove --window <id> x y` (the id from
`xdotool search --all --pid $(cat "$LIVE_DIR/pid") --name '^Movian Go$'`; without
`--all` xdotool matches pid OR name, so any window named "Movian Go").

After verifying the listener scope with `ss`, HTTP Control can drive the
development run, including an authenticated E2E. Keep its log endpoint and
raw traces out of agent-readable output; use redacted metadata when reporting.

```sh
node tools/live/stpp.js page [max] [--open <route>]   # route, title, loading, error, items
```

`page` prints the current page; `--open <route>` opens the route and waits
until it has loaded (or failed), exiting 1 after `STPP_WAIT_MS` (15 s) with
what it has. Do not read the page with `curl` over `/api/prop`.

## Driving it

```sh
export DISPLAY=$(cat "$LIVE_DIR/display")              # M7 (start.sh): :$(cat "$LIVE_DIR/xvfb.display")
xdotool mousemove 250 119 click 1                       # click an item
printf '%s' "$USERNAME" | xdotool type --delay 80 --file -
printf '%s' "$PASSWORD" | xdotool type --delay 80 --file -   # never as an argument
xdotool key Return
xdotool key Escape                                      # Back
xdotool mousemove 640 400; for i in $(seq 1 40); do xdotool click 5; done   # scroll down (4 = up)
```

- **Back (Escape) closes the browser window** (`webpopup` returns
  `userclose`); that is how the user finishes the Cloudflare clearance window
  (`rutracker:refreshclearance`, or the first Password Login that needs one).
- Clicking a text field of a web page in the window focuses it; typed keys
  reach the page.
- F5 does not reload a Movian page. Go Back and open it again.
- Movian's own login dialog (Password Login): answer it with
  `node tools/live/login.js [--remember] <credentials.env>` instead of the
  mouse. It fills the fields over STPP and sends Enter, with "Remember me"
  off unless `--remember`. The file holds `RUTRACKER_TEST_USER=` and
  `RUTRACKER_TEST_PASSWORD=` (mode 0600, outside the repository); the values
  never reach the command line or the output. Exit 0 means the dialog closed,
  not that the sign-in passed: check the log or `state.js` for that.
- `node tools/live/state.js "$LIVE_DIR"` prints the Session store, the
  Clearance, Movian's cookie jar and Core record, the keyring and the
  browser's cookies, names and lengths only. Movian writes `httpcookies` a
  few seconds after a change: read it again before concluding.
- Give a page time: 10–15 s after a click that loads from RuTracker.

## End-to-end check of RuTracker sign-in (Movian Go)

1. `mgo-start.sh` with the ZIP of the branch and `rutracker:start`; shot:
   "Войти на RuTracker.org" is the first item, and no "встроенный браузер"
   item is there (#22).
2. Click it. If no Clearance is held, the Cloudflare window opens first:
   wait for "Performing security verification" to pass, then close the
   window (Escape). Interactive check: stop, ask the owner.
3. Movian's login dialog: `node tools/live/login.js <credentials.env>`
   (see "Driving it"). Shot: the start page shows "Сессия (вход по паролю): вход выполнен как …".
4. Protected pages: search (click the search row, type a query, Return),
   a topic, its "Торрент-ссылка".
5. Restart: `tools/live/mgo-stop.sh --keep`, then `mgo-start.sh` again
   with the same ZIP; open the plugin from Home: the session is restored
   and re-checked.
6. "Забыть сессию" → guest page. Click "Войти на RuTracker.org" again: the
   login dialog must show (no silent sign-in, #22), even with the password
   saved; type it and sign in.
8. Leak scan is advisory. Keep the profile for restart/session tests; after
   those are complete, use `mgo-stop.sh --wipe` for explicit cleanup.

What to expect from RuTracker, as observed: its logout does not end the
session on the server (the old cookie stays valid), and Password Login is
stopped by Cloudflare at `login.php` while the site challenges.

## Password Login with clearance (verified 2026-11-15, before #22)

Built-in Browser Login (the window's cookies as a Session) is removed (#22,
docs/adr/0004); the window only gets the Clearance. The run below used
Password Login, which is unchanged.

MGO desktop (CEF) and Android (WebView), clean profiles, `-d` / httpdebug:
the browser window gets `cf_clearance`; the login POST carries only it and
its User-Agent; the answer's `bb_*` plus that pair become the Active
Session (source `password`, the browser UA). Search works, and so does a
restart. With `cf_clearance` deleted from the CEF / WebView cookie store,
login, check and restart pass again without a browser window: the clearance
comes from the Core record.

## One copy of cf_clearance (docs/adr/0003, verified 2026-11-15)

- MGO desktop (CEF) and Android (WebView), clean profiles: after Password
  Login the Session store holds `bb_session` and `bb_ssl` only, the Core
  record holds `cf_clearance` and Core sends it with the Session. Search,
  restart, and login again with `cf_clearance` deleted from the browser
  store (no window opened) all pass.
- MGO desktop, a profile saved before the change: the Session lost its
  `cf_clearance` at start, the Core record took over, search works.
- M7 desktop, Cookie Bridge transfer over STPP (`bb_*` + `cf_clearance` +
  UA): Active Session `bb_session`, `bb_ssl`; the Clearance in the plugin
  store (`rutracker_clearance`); search works before and after a restart.

## Clearance-only Password Login (verified MGO E2E, before 2026-11-15)

This run predates the change that made this login an Active Session; the
`bb_*` now also live in the Session Coordinator store.

- Owner completed the Cloudflare challenge in the built-in CEF. For the
  clean test profile, only `cf_clearance` was reused from that temporary CEF
  profile; no `bb_*` browser cookies were copied.
- The newly built `x11 glfw webpopup cef` binary ran from an installed,
  allowlisted ZIP. Password Login automatically closed the cookie-aware CEF
  popup and returned to the signed-in plugin page; no manual Escape was
  needed in this flow.
- The response placed `bb_session` and `bb_ssl` in `persistent/settings/httpcookies`;
  the plugin Session Coordinator store had no copy. Search, forum category,
  topic and direct `dl.php` torrent access worked.
- After restarting MGO, both `bb_*` cookies remained in the Core Jar. A
  protected search before clearance refresh received Cloudflare's challenge.
  Password Login reacquired clearance from CEF; protected requests then
  worked without creating a new password session. The clearance pair itself
  is memory-only.
- This historical run used a temporary profile, analytics disabled, HTTP
  Control off, installed ZIP, no `-p` and no raw HTTP tracing. That setup
  records the evidence for that run; it is not a blanket development gate.
  Current diagnostics and profile rules are in the policy above.
- Node suite passed 205 checks. The full Go suite passed with
  `x11 glfw webpopup cef` and the existing CEF runtime in `LD_LIBRARY_PATH`.
- `leakscan --db` could not collect cookie values from the CEF database
  (exit 2; no values to scan), so no full leakscan pass is claimed. A
  separate in-memory scan checked 11 log/cache/plugin-store files for the
  Core Jar `bb_session` and found no match. `bb_ssl` is below the scanner's
  minimum value length; the CEF clearance value was not covered by that
  helper. No cookie values or log contents were printed.

## Movian Go core checks (no person needed)

For webpopup or cookie behaviour use a loopback lab with dummy cookies
instead of RuTracker: the lab server and plugin are in the bodies of
Buksa/movian-go#10 and #11. Open the lab
route with `node tools/live/stpp.js open <route>`; the trap URL
closes the window, so nothing has to be clicked.

## Pitfalls

| Symptom | Cause | Fix |
|---|---|---|
| Xvfb screen black, `xwininfo -root -tree` shows no window | GLFW took Wayland (WSLg): `WAYLAND_DISPLAY`, and even without it libwayland's default `wayland-0` in `XDG_RUNTIME_DIR`; the window opened on the owner's desktop | `env -u WAYLAND_DISPLAY XDG_RUNTIME_DIR=<empty 0700 dir>` (`mgo-start.sh` does it) |
| `webpopup` returns `neterror` at once | the route that opens it was the start URL; GLW was not up | open it from the UI |
| Start page right after launch: "проверяется...", no forum list | the page was built before the Session Check and the network (#6) | fixed in #6: `:start` checks inline and shows a warning line when the site cannot be reached; on an older build open the plugin from Home a moment later |
| Node STPP client: "cannot connect" to Movian Go | Builds before czz/movian-go `d1d6026` (2026-10-27) sent `Connection` twice in the 101 reply and closed the socket right after it | fixed upstream (czz/movian-go#14); on an older build seed settings files and use `/api/open` and `/api/prop` |
| movian-go ignores SIGTERM | after any browser window session | `stop_pid` waits 10 s, then SIGKILL; kill its children by `ps --ppid` |
| Start page after a restart: "не проверена: сетевая ошибка", though pages load | Movian Go: a page opened while the start-up Session Check waits makes that check's `io.httpReq` return undefined (`TypeError: Cannot read property 'buffer' of undefined` in `movian/http.js`) | open the plugin a few seconds after start; Buksa/movian-go#33 |
| Leak scan finds nothing at all | it ran after `stop.sh --wipe` removed the profile | scan first, then explicitly wipe |
| A failing test run looked green | `node tests/run.js \| tail` returns tail's exit code | redirect to a file and check `$?` |
| The plugin's own torrent item shows an empty page on Movian Go | any `torrent:browse:…` stays empty there: its redirect to `torrentfile://<hash>/` is not followed (`data:` URLs themselves work) | use "Торрент-ссылка" (the plain `dl.php` URL) |
| `bb_guid` found in `webkit/Default/Local Storage` | RuTracker's own script stores it in the browser | not a plugin leak; retain the local profile for E2E, then explicitly wipe if no longer needed |
