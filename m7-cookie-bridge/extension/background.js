/* global chrome, importScripts, BridgeCore */

importScripts('lib/bridge-core.js');

var MAX_REQUESTS = 40;
var SECRET_HEADERS = {
    authorization: true,
    cookie: true,
    'proxy-authorization': true,
    'set-cookie': true
};

function activeDomain(values) {
    var profile = BridgeCore.profile(values.profile || 'hdrezka');
    return BridgeCore.normalizeDomain(values.domain, profile.defaultDomain);
}

function requestBelongsToDomain(details, domain) {
    if (BridgeCore.domainMatches(BridgeCore.hostFromUrl(details.url), domain)) return true;
    if (BridgeCore.domainMatches(BridgeCore.hostFromUrl(details.initiator), domain)) return true;
    if (BridgeCore.domainMatches(BridgeCore.hostFromUrl(details.documentUrl), domain)) return true;
    return false;
}

function redactHeaders(headers) {
    var out = [];
    headers = headers || [];
    for (var i = 0; i < headers.length; i++) {
        var header = headers[i];
        var name = header.name || '';
        var key = name.toLowerCase();
        out.push({
            name: name,
            value: SECRET_HEADERS[key] ? '[present]' : String(header.value || '')
        });
    }
    return out;
}

function compactRequest(details) {
    return {
        at: new Date().toISOString(),
        method: details.method,
        type: details.type,
        url: details.url,
        initiator: details.initiator || details.documentUrl || '',
        requestHeaders: redactHeaders(details.requestHeaders)
    };
}

function pushRequest(details) {
    chrome.storage.local.get({ profile: 'hdrezka', domain: '', recentRequests: [] }, function (values) {
        if (!requestBelongsToDomain(details, activeDomain(values))) return;

        var recent = values.recentRequests || [];
        recent.unshift(compactRequest(details));
        if (recent.length > MAX_REQUESTS) recent = recent.slice(0, MAX_REQUESTS);
        chrome.storage.local.set({ recentRequests: recent });
    });
}

/*
 * Header capture only. Only the two configured profile domains are kept, and
 * secret headers (Cookie, Authorization, ...) are replaced with '[present]'
 * before they are stored or shown. Cookie values never reach storage.
 */
chrome.webRequest.onBeforeSendHeaders.addListener(
    pushRequest,
    { urls: ['<all_urls>'] },
    ['requestHeaders', 'extraHeaders']
);
