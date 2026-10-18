/* global chrome, BridgeCore */

function $(id) {
    return document.getElementById(id);
}

/* The profile list comes from BridgeCore, so a new profile is one entry there. */
BridgeCore.PROFILE_ORDER.forEach(function (id) {
    var option = document.createElement('option');
    option.value = id;
    option.textContent = BridgeCore.profile(id).title;
    $('profile').appendChild(option);
});

function setStatus(text, kind) {
    $('status').className = kind || '';
    $('status').textContent = text;
}

function setBusy(busy) {
    var buttons = document.querySelectorAll('button');
    for (var i = 0; i < buttons.length; i++) buttons[i].disabled = busy;
}

function currentProfile() {
    return BridgeCore.profile($('profile').value);
}

/* Where Movian may be addressed: loopback by default. A device on the local
 * network only after the user ticks "allowLan" - STPP is unauthenticated
 * plaintext ws://, so that is an accepted risk, not a protected channel.
 * Public addresses are refused either way (BridgeCore.movianHostAllowed). */
var LOOPBACK_ONLY = 'Movian host должен быть 127.0.0.1 или localhost. ' +
    'Для ТВ-приставки: туннель (ssh -L 42000:127.0.0.1:42000 … или ' +
    'adb forward tcp:42000 tcp:42000) либо галочка «по локальной сети без шифрования».';
var LAN_ONLY = 'Movian host должен быть 127.0.0.1/localhost или адресом локальной сети ' +
    '(192.168.x.x, 10.x.x.x, 172.16-31.x.x, 169.254.x.x, имя .local/.lan). ' +
    'Публичные адреса не принимаются.';

function hostProblem() {
    var host = $('host').value;
    if (BridgeCore.movianHostAllowed(host, $('allowLan').checked)) return '';
    return BridgeCore.isLanHost(host) ? LOOPBACK_ONLY : LAN_ONLY;
}

function requireAllowedHost() {
    var problem = hostProblem();
    if (problem) throw new Error(problem);
}

function overLan() {
    return !BridgeCore.isLoopbackHost($('host').value);
}

/* Asks Chrome for access to the profile site. Already-granted sites resolve
 * without a prompt; must run inside the click handler (user gesture). */
function requestSiteAccess(domain) {
    return chrome.permissions.request({ origins: BridgeCore.siteOrigins(domain) });
}

function movianBase() {
    return 'http://' + BridgeCore.normalizeHost($('host').value) +
        ':' + BridgeCore.normalizePort($('port').value);
}

function stppUrl() {
    return 'ws://' + BridgeCore.normalizeHost($('host').value) +
        ':' + BridgeCore.normalizePort($('port').value) + '/api/stpp';
}

function chromeGet(keys) {
    return new Promise(function (resolve) {
        chrome.storage.local.get(keys, resolve);
    });
}

function chromeSet(values) {
    return new Promise(function (resolve) {
        chrome.storage.local.set(values, resolve);
    });
}

function chromeCreateTab(url) {
    return new Promise(function (resolve) {
        chrome.tabs.create({ url: url }, resolve);
    });
}

function chromeGetCookies(details) {
    return new Promise(function (resolve) {
        chrome.cookies.getAll(details, resolve);
    });
}

function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 1200);
    options = options || {};
    options.signal = controller.signal;
    /* Movian sends no CORS headers; an opaque answer still tells "online"
     * and /api/open still runs, without host permission for a LAN box. */
    options.mode = 'no-cors';
    return fetch(url, options).finally(function () {
        clearTimeout(timer);
    });
}

function headerValue(headers, name) {
    name = String(name).toLowerCase();
    headers = headers || [];
    for (var i = 0; i < headers.length; i++) {
        if (String(headers[i].name || '').toLowerCase() === name) return headers[i].value || '';
    }
    return '';
}

function shortUrl(url) {
    try {
        var parsed = new URL(url);
        var path = parsed.pathname + (parsed.search || '');
        if (path.length > 88) path = path.substring(0, 85) + '...';
        return parsed.hostname + path;
    } catch (_e) {
        return String(url || '').substring(0, 110);
    }
}

function formatRequest(req) {
    var headers = req.requestHeaders || [];
    var lines = [
        req.at + '  ' + req.method + '  ' + req.type,
        shortUrl(req.url)
    ];
    var initiator = req.initiator ? shortUrl(req.initiator) : '';
    if (initiator) lines.push('initiator: ' + initiator);

    ['user-agent', 'accept', 'accept-language', 'origin', 'referer', 'cookie'].forEach(function (name) {
        var value = headerValue(headers, name);
        if (value) lines.push(name + ': ' + value);
    });

    return lines.join('\n');
}

function renderRecentRequests() {
    return chromeGet({ recentRequests: [] }).then(function (values) {
        var recent = values.recentRequests || [];
        $('requestCount').textContent = String(recent.length);
        $('requests').textContent = recent.length
            ? recent.slice(0, 12).map(formatRequest).join('\n\n---\n\n')
            : 'No captured requests yet.';
    });
}

function probeMovian() {
    if (hostProblem()) {
        $('movianState').textContent = 'blocked';
        return Promise.resolve(false);
    }
    return fetchWithTimeout(movianBase() + '/api/diag', {}, 1200)
        .then(function () {
            $('movianState').textContent = 'online';
            return true;
        })
        .catch(function () {
            $('movianState').textContent = 'offline';
            return false;
        });
}

/* Reads cookies for the active profile domain only. Values stay in memory and
 * are never written to storage, the status line, or the request log. */
function readBrowserState() {
    var profile = currentProfile();
    var domain = BridgeCore.normalizeDomain($('domain').value, profile.defaultDomain);
    var url = 'https://' + domain + '/';
    var site = 'https://' + domain;

    /* Query by `domain`, never by `url`. chrome.cookies.getAll({url}) restricts
     * the result to cookies that would actually be sent to that URL, which is
     * path-aware: RuTracker's session cookie lives on path=/forum/, so asking
     * for https://rutracker.org/ returns cf_clearance only and silently drops
     * bb_session/bb_guid/bb_ssl. A session transfer wants every cookie of the
     * profile domain. */
    var unpartitioned = chromeGetCookies({ domain: domain });

    /* Then ask again for the partitioned (CHIPS) namespace. Cloudflare marks
     * cf_clearance as partitioned; without this second call it is missing and
     * Cloudflare keeps challenging Movian even though the session is valid. */
    var partitioned = chromeGetCookies({
        domain: domain,
        partitionKey: { topLevelSite: site }
    }).catch(function () {
        return []; /* older Chrome without CHIPS support */
    });

    return Promise.all([unpartitioned, partitioned]).then(function (lists) {
        var cookies = BridgeCore.mergeCookieLists(lists[0], lists[1]);
        $('cookieCount').textContent = String(cookies.length);
        return {
            profile: profile,
            domain: domain,
            url: url,
            cookies: cookies,
            cookieHeader: BridgeCore.buildCookieHeader(cookies),
            ua: navigator.userAgent
        };
    });
}

/* Writes the given STPP SET messages and resolves on transport success. */
function sendStpp(messages) {
    return new Promise(function (resolve, reject) {
        var ws = new WebSocket(stppUrl());
        var finished = false;
        var timer = setTimeout(function () {
            if (finished) return;
            finished = true;
            try { ws.close(); } catch (_e) {}
            reject(new Error('STPP timeout'));
        }, 3500);

        ws.onopen = function () {
            ws.send(JSON.stringify([0, 1, 0])); // STPP_CMD_HELLO
            for (var i = 0; i < messages.length; i++) {
                ws.send(JSON.stringify(messages[i]));
            }
            setTimeout(function () {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                ws.close();
                resolve();
            }, 450);
        };

        ws.onerror = function () {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            reject(new Error('Cannot connect to ' + stppUrl()));
        };
    });
}

function openMovianRoute() {
    requireAllowedHost();
    return fetchWithTimeout(movianBase() + '/api/open?url=' +
        encodeURIComponent(currentProfile().movianRoute), {}, 1500);
}

function saveInputs() {
    return chromeSet({
        profile: currentProfile().id,
        domain: BridgeCore.normalizeDomain($('domain').value, currentProfile().defaultDomain),
        host: BridgeCore.normalizeHost($('host').value),
        port: BridgeCore.normalizePort($('port').value),
        allowLan: $('allowLan').checked
    });
}

function refreshStatus() {
    saveInputs();
    readBrowserState()
        .then(function (state) {
            var lines = [
                'Профиль: ' + state.profile.title,
                'Домен: ' + state.domain,
                'Cookies: ' + state.cookies.length,
                'User-Agent length: ' + state.ua.length
            ];
            if (hostProblem()) {
                lines.push('');
                lines.push(hostProblem());
            }
            else if (overLan()) {
                lines.push('');
                lines.push('ВНИМАНИЕ: передача по локальной сети без шифрования (включено вами).');
            }
            if (!BridgeCore.domainAllowed(state.profile.id, state.domain)) {
                lines.push('');
                lines.push('Домен ' + state.domain + ' не входит в профиль ' + state.profile.title +
                    ': ' + state.profile.domains.join(', '));
            }
            setStatus(lines.join('\n'), state.cookieHeader ? 'ok' : '');
        })
        .then(probeMovian)
        .then(renderRecentRequests)
        .catch(function (err) {
            setStatus(String(err && err.message || err), 'bad');
        });
}

$('openSite').addEventListener('click', function () {
    var domain = BridgeCore.normalizeDomain($('domain').value, currentProfile().defaultDomain);
    saveInputs().then(function () {
        return chromeCreateTab('https://' + domain + '/');
    });
});

$('openMovian').addEventListener('click', function () {
    setBusy(true);
    saveInputs()
        .then(openMovianRoute)
        .then(function () {
            setStatus('Открыто в Movian: ' + currentProfile().movianRoute, 'ok');
        })
        .catch(function (err) {
            setStatus('Cannot open Movian route: ' + (err && err.message || err), 'bad');
        })
        .finally(function () {
            setBusy(false);
            probeMovian();
        });
});

$('send').addEventListener('click', function () {
    var profile = currentProfile();
    var domain = BridgeCore.normalizeDomain($('domain').value, profile.defaultDomain);
    if (hostProblem()) {
        setStatus(hostProblem(), 'bad');
        return;
    }
    if (!BridgeCore.domainAllowed(profile.id, domain)) {
        setStatus('Домен ' + domain + ' не входит в профиль ' + profile.title +
            ': ' + profile.domains.join(', '), 'bad');
        return;
    }
    var access = requestSiteAccess(domain);
    setBusy(true);
    access
        .then(function (granted) {
            if (!granted) throw new Error('Нет доступа к cookies ' + domain + ': разрешение не выдано.');
        })
        .then(saveInputs)
        .then(readBrowserState)
        .then(function (state) {
            if (!state.cookieHeader) {
                throw new Error('No cookies for ' + state.domain +
                    '. Откройте ' + state.profile.title + ' в браузере и пройдите проверку/вход.');
            }
            setStatus('Отправка cookies в Movian...');
            var messages = BridgeCore.stppSetMessages(state.profile.id, state.cookieHeader, state.ua);
            return sendStpp(messages).then(function () {
                return state;
            });
        })
        .then(function (state) {
            var info = BridgeCore.describeTransfer(state.profile.id, state.cookies, state.ua);
            setStatus(
                'Записано в Movian (транспорт OK).' +
                '\nПрофиль: ' + state.profile.title +
                '\nCookies: ' + info.cookieCount +
                '\nUA length: ' + info.uaLength +
                (overLan() ? '\nПередано по локальной сети без шифрования.' : '') +
                '\n\nАвторизация ещё НЕ подтверждена: её проверяет сам Movian.' +
                '\nОткройте ' + state.profile.movianRoute + ' и смотрите статус Cookie Bridge.',
                'ok'
            );
            return probeMovian();
        })
        .catch(function (err) {
            setStatus(String(err && err.message || err), 'bad');
        })
        .finally(function () {
            setBusy(false);
        });
});

$('clearSession').addEventListener('click', function () {
    setBusy(true);
    saveInputs()
        .then(function () {
            requireAllowedHost();
            var profile = currentProfile();
            return sendStpp(BridgeCore.stppSetMessages(profile.id, '', '')).then(function () {
                setStatus('Сессия профиля ' + profile.title + ' очищена в Movian.', 'ok');
            });
        })
        .catch(function (err) {
            setStatus(String(err && err.message || err), 'bad');
        })
        .finally(function () {
            setBusy(false);
            probeMovian();
        });
});

$('refreshRequests').addEventListener('click', function () {
    renderRecentRequests();
});

/* The request log sees only sites the extension may access. Stream/CDN hosts
 * are unknown in advance, so capturing them is an explicit opt-in. */
$('captureAll').addEventListener('click', function () {
    chrome.permissions.request({ origins: ['http://*/*', 'https://*/*'] }).then(function (granted) {
        setStatus(granted ? 'Захват запросов ко всем сайтам включён.' : 'Захват ограничен сайтами профилей.',
            granted ? 'ok' : '');
    });
});

$('clearRequests').addEventListener('click', function () {
    chromeSet({ recentRequests: [] }).then(function () {
        renderRecentRequests();
    });
});

$('profile').addEventListener('change', function () {
    var profile = currentProfile();
    $('domain').value = profile.defaultDomain;
    refreshStatus();
});

document.addEventListener('DOMContentLoaded', function () {
    chromeGet({
        profile: 'hdrezka',
        host: '127.0.0.1',
        port: '42000',
        domain: '',
        allowLan: false
    }).then(function (values) {
        var profile = BridgeCore.profile(values.profile);
        $('profile').value = profile.id;
        $('domain').value = BridgeCore.normalizeDomain(values.domain, profile.defaultDomain);
        $('host').value = values.host || '127.0.0.1';
        $('port').value = values.port || '42000';
        $('allowLan').checked = values.allowLan === true;
        refreshStatus();
    });
});

$('domain').addEventListener('change', refreshStatus);
$('allowLan').addEventListener('change', refreshStatus);
$('host').addEventListener('change', refreshStatus);
$('port').addEventListener('change', refreshStatus);
