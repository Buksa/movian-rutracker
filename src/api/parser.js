/*
 * RuTracker HTML parsing: page text in, plain data out. No HTTP, no Movian
 * pages. The regular expressions are the ones the plugin has used since
 * 0.7.x, kept in one place; the few lookups that need a DOM use Movian's
 * gumbo-backed movian/html.
 */
var html = require('movian/html');

//  Single-match expressions are not /g: a shared /g regex keeps lastIndex
//  between calls and then misses the match on the next page.
var LOGIN = /"logged-in-username".*?>([\s\S]*?)<\//;
var AUTH_FAIL = /class=".*?mrg_16">/;
var CAPTCHA = /<div><img src=".*?\/\/(.*?)"[\s\S]*?<input type="hidden" name="cap_sid" value="(.*?)">[\s\S]*?<input .*?type="text" name="(.*?)"/;
var SEED = /class="seed">.*<b>([\d]{0,200}?)<\/b>/;
var LEECH = /class="leech">.*<b>([\d]{0,200}?)<\/b>/;
//  Loop expressions get a fresh instance per call for the same reason.
var SUBFORUM = '"forumlink".*?href=".*?viewforum\\.php\\?f=([\\s\\S]{0,200}?)".*?>([\\s\\S]*?)<\\/a>';
var TOPIC_ROW = 'id=.*?href=".*?viewtopic\\.php\\?t=([\\d]{0,200}?)".*?>([\\s\\S]*?)<\\/a>([\\s\\S]*?)<\\/tr>';

function each(source, text, fn) {
  var re = new RegExp(source, 'g');
  var m;
  while ((m = re.exec(text))) fn(m);
}

function first(re, text) {
  var m = re.exec(text);
  return m ? m[1] : '';
}

//  Markup and the entities RuTracker uses in titles and posts.
function cleanText(s) {
  return String(s).replace(/<.*?>/g, '').replace(/&nbsp;/g, '').replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»').replace(/(&amp;|\\u0026)/g, '&').replace(/&#039;/g, '`').replace(/–/g, '-').trim();
}

//  A post's HTML as one line of text.
function htmlToText(s) {
  return cleanText(String(s)
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, function (m, code) { return String.fromCharCode(+code); })
    .replace(/&middot;/g, '·')
    .replace(/&darr;/g, '↓')
    .replace(/\s+/g, ' '));
}

//  "18.45&nbsp;GB &#8595;" inside a download link -> "18.45 GB".
function cleanSize(s) {
  return String(s).replace(/<.*?>/g, '').replace(/&nbsp;/g, ' ').replace(/&#8595;|↓/g, '').replace(/\s+/g, ' ').trim();
}

exports.loginName = function (text) {
  var m = LOGIN.exec(String(text || ''));
  return m ? m[1] : null;
};

exports.loginFailed = function (text) {
  return AUTH_FAIL.test(String(text || ''));
};

exports.captcha = function (text) {
  var m = CAPTCHA.exec(String(text || ''));
  return m ? {image: m[1], sid: m[2], field: m[3]} : null;
};

//  Forum links ("forumlink") on the index and on forum pages.
exports.subforums = function (text) {
  var out = [];
  each(SUBFORUM, String(text || ''), function (m) {
    out.push({id: m[1], title: m[2]});
  });
  return out;
};

//  Topic rows. Forum pages and bookmarks share one layout, the tracker
//  search page (tracker.php) another.
exports.topicRows = function (text, layout) {
  var out = [];
  each(TOPIC_ROW, String(text || ''), function (m) {
    var cells = m[3];
    var row = {topicId: m[1], title: cleanText(m[2]), size: '0', seeders: '0', leechers: '0', added: ''};
    if (row.title === '') return;
    if (layout === 'tracker') {
      row.size = cleanSize(first(/<td.*?tor-size.*?>([\s\S]*?)<\/td>/, cells)) || '0';
      row.seeders = first(/seedmed[\s\S]*?>(\d{0,10})<\/b>/, cells).trim() || '0';
      row.leechers = first(/leechmed[\s\S]*?>(\d{0,10})<\/td>/, cells).trim() || '0';
      row.added = first(/<td[\s\S]*?p>([\s\S]*?)<\/td>/, cells).replace(/<.*?>/g, '').replace(/(\r|\n)/g, '').replace(/(     |    |   |  )/g, ' ').trim();
    }
    else {
      row.size = cleanSize(first(/class="small">([\s\S]*?)<\/div>/, cells)) || '0';
      row.seeders = first(/seedmed[\s\S]*?<b>(\d{0,10})<\/b>/, cells).trim() || '0';
      row.leechers = first(/leechmed[\s\S]*?>(\d{0,10})<\/b>/, cells).trim() || '0';
      row.added = first(/class=".*?-last-.*?"[\s\S]*?>([0-9\-: ]+)<\/(p|div)>/, cells).trim();
    }
    out.push(row);
  });
  return out;
};

//  Is this a tracker.php result page? An empty result still has the results
//  table (with a "Не найдено" row); a challenge or error page has none.
exports.searchResults = function (text) {
  return /id="tor-tbl"/.test(String(text || ''));
};

//  Is this a bookmarks.php page? An empty list says so in a message; a list
//  with topics has the topic rows of a forum page, which bookmarks share. A
//  challenge or a guest page has neither.
exports.bookmarksPage = function (text) {
  text = String(text || '');
  return /У вас нет избранных тем/.test(text) || exports.topicRows(text, 'forum').length > 0;
};

//  The "След." (next) pager link inside the element with `containerClass`,
//  as a path relative to /forum/, or null on the last page.
exports.nextPage = function (dom, containerClass) {
  try {
    var links = dom.root.getElementByClassName(containerClass)[0].getElementByClassName('pg');
    var last = links[links.length - 1];
    var href = last.attributes.getNamedItem('href').value;
    return href && last.textContent === 'След.' ? href : null;
  }
  catch (err) {
    return null;
  }
};

exports.parse = function (text) {
  return html.parse(String(text || ''));
};

//  Inner HTML of each <div> whose class list starts with `cls`, found by
//  counting nested <div>s. Post text is read this way rather than through
//  DOM textContent: Movian's native textContent pushes one Duktape value per
//  text node without growing the stack, so on a long post it throws
//  "attempt to push beyond currently allocated stack" (es_gumbo.c).
function divBlocks(text, cls) {
  var out = [];
  var open = new RegExp('<div[^>]*class="' + cls + '["\\s]', 'g');
  var m;
  while ((m = open.exec(text))) {
    var start = text.indexOf('>', m.index) + 1;
    var tag = /<(\/?)div\b/gi;
    var depth = 1;
    var end = text.length;
    var t;
    tag.lastIndex = start;
    while (depth && (t = tag.exec(text))) {
      depth += t[1] ? -1 : 1;
      end = t.index;
    }
    out.push(text.slice(start, end));
    open.lastIndex = end;
  }
  return out;
}

function attr(nodes, name) {
  var n = nodes && nodes.length ? nodes[0] : null;
  var a = n && n.attributes ? n.attributes.getNamedItem(name) : null;
  return a && a.value ? a.value : '';
}

//  The first post of a topic: poster image, text and its own links.
function firstPost(post, html) {
  if (!post) return {image: '', text: '', torrent: '', magnet: ''};
  var image = attr(post.getElementByClassName('postImg postImgAligned img-right'), 'title') ||
    attr(post.getElementByClassName('poster'), 'src') ||
    attr(post.getElementByClassName('postImg'), 'src');
  return {
    image: image,
    text: html ? htmlToText(html) : '',
    torrent: attr(post.getElementByClassName('dl-link'), 'href'),
    magnet: attr(post.getElementByClassName('magnet-link'), 'href'),
  };
}

//  Everything the topic route shows. `skipFirst` drops the opening post
//  from the comments (it is shown as the release itself on page one).
exports.topicPage = function (text, skipFirst) {
  text = String(text || '');
  var dom = exports.parse(text);
  var wraps = dom.root.getElementByClassName('post_wrap');
  var bodies = divBlocks(text, 'post_body');
  var comments = [];
  for (var i = skipFirst ? 1 : 0; i < bodies.length; i++) {
    var comment = htmlToText(bodies[i]);
    if (comment) comments.push(comment);
  }
  var download = /download.php[^"]+/.exec(text);
  var dl = /dl.php[^"]+/.exec(text);
  var magnet = /magnet:\?[^"]+/.exec(text);
  return {
    post: firstPost(wraps.length ? wraps[0] : null, divBlocks(text, 'post_wrap')[0]),
    download: download ? download[0].replace(/amp;/g, '').trim() : '',
    dl: dl ? dl[0].replace(/amp;/g, '').trim() : '',
    magnet: magnet ? magnet[0].replace(/amp;/g, '').trim() : '',
    seeders: first(SEED, text) || 0,
    leechers: first(LEECH, text) || 0,
    comments: comments,
    next: exports.nextPage(dom, 'nav pad_6 row1'),
  };
};
