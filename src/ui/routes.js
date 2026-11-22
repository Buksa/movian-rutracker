/*
 * Movian pages: routes, the global searcher and the item hook. Turns catalog
 * and auth results into items; no HTTP and no HTML parsing here.
 */
var page = require('movian/page');
var popup = require('native/popup');

var blue = '6699CC';
var orange = 'FFA500';
var red = 'EE0000';
var green = '66FF72';
var gray = '555555';

//  Movian renders objects with toRichString() as rich text (<font> etc.).
function RichText(x) {
  this.str = x.toString();
}
RichText.prototype.toRichString = function () {
  return this.str;
};

function colorStr(str, color) {
  return '<font color="' + color + '"> (' + str + ')</font>';
}

function coloredStr(str, color) {
  return '<font color="' + color + '">' + str + '</font>';
}

var TOS = 'Плагин предназначен исключительно для образовательных и тестовых целей. Разработчики плагина не имеют отношения к данным сайтам и интернет-ресурсам, не получают каких-либо денег или иных льгот, не несут НИКАКОЙ ответственности за любые действия при использовании плагина. Вы несете единоличную ответственность за соблюдение применимого законодательства и должны прекратить использование плагина, если ваши действия приведут или могут привести к каким-либо нарушениям законодательства.\n\n' +
  'Принимаете ли вы эти условия использования?';

/*
 * ctx: {id, title, path, logo, config, catalog, auth, client, session,
 *       clearance}
 *   config    - live settings values (see src/ui/settings.js)
 *   session   - the Session Coordinator (src/bridge/session.js)
 *   clearance - the Clearance (src/bridge/clearance.js)
 */
exports.register = function (ctx) {
  var PREFIX = ctx.id;
  var TTL = ctx.title;
  var LOGO = ctx.logo;
  var config = ctx.config;
  var catalog = ctx.catalog;
  var client = ctx.client;
  var clearance = ctx.clearance;
  var icon = {
    background: ctx.path + 'src/back.jpg',
    arrow: ctx.path + 'src/arrow.png',
    logo: ctx.path + 'src/logo.png',
    folder: ctx.path + 'src/folder.png',
    icon: ctx.path + 'src/icon.png',
    bookmarks: ctx.path + 'src/bookmarks.png',
    exit: ctx.path + 'src/exit.png',
    hd1080: ctx.path + 'src/1080.png',
    hd720: ctx.path + 'src/720.png',
    none: ctx.path + 'src/none.png',
    uhd: ctx.path + 'src/4k.png',
  };

  function setup(p, title) {
    p.metadata.background = icon.background;
    p.metadata.logo = LOGO;
    p.metadata.icon = LOGO;
    if (title !== undefined) p.metadata.title = title;
  }

  function qualityIcon(title) {
    if (/720/.test(title)) return icon.hd720;
    if (/1080/.test(title)) return icon.hd1080;
    if (/2160/.test(title)) return icon.uhd;
    return icon.none;
  }

  //  One topic row of a forum, bookmark or search list.
  function appendTopic(p, row, n, addedLabel) {
    var logofilm = qualityIcon(row.title);
    p.appendItem(PREFIX + ':topic:' + row.topicId + ':' + encodeURIComponent(row.title), config.list, {
      title: new RichText(n + ' | ' + row.title),
      icon: logofilm,
      backdrops: [{url: logofilm}, {url: icon.logo}, {url: ''}],
      tagline: new RichText(row.added ? coloredStr(addedLabel, gray) + row.added : ''),
      description: new RichText(coloredStr('Название: ', orange) + row.title + '<br>' +
        coloredStr('Размер: ', blue) + row.size + '<br>' +
        coloredStr('Сидеры: ', green) + row.seeders + '<br>' +
        coloredStr('Личеры: ', red) + row.leechers),
    });
  }

  var ELSEWHERE = 'Обновите проверку Cloudflare или передайте сессию через Cookie Bridge.';
  //  Password Login results that end the login page with a message.
  var LOGIN_ERRORS = {
    network: function () {
      return 'Вход не выполнен: сетевая ошибка';
    },
    cancelled: function () {
      return 'Вход отменён: сессию забыли или очистили во время проверки, либо начат другой вход. Пароль не запрашивается снова.';
    },
    challenge: function () {
      return 'Вход не выполнен: сайт требует проверку Cloudflare. ' + ELSEWHERE;
    },
    insecure: function () {
      return 'Вход по паролю возможен только по https: выберите https-домен в настройках плагина.';
    },
    unverified: function (r) {
      return 'Пароль принят, но вход не подтверждён: ' + (r.check === 'challenge' ?
        'Cloudflare не пускает на форум. ' + ELSEWHERE : ctx.session.statusText(r.check) + '.') +
        ' Прежняя сессия не изменилась.';
    },
  };

  var CLEARANCE_ERRORS = {
    cancelled: function () {
      return 'Окно проверки закрыто до получения Cloudflare clearance. Вход по паролю не запускался.';
    },
    empty: function () {
      return 'Movian не смогла прочитать cf_clearance из CEF. Повторите попытку или используйте Cookie Bridge.';
    },
    unsupported: function () {
      return 'Cookie-aware CEF недоступен в этой сборке. Передайте сессию через Cookie Bridge.';
    },
    neterror: function () {
      return 'Не удалось открыть CEF или прочитать cookies. Повторите попытку или используйте Cookie Bridge.';
    },
    persistfailed: function () {
      return 'Movian Go не смогла сохранить Cloudflare clearance с подтверждённым сроком действия. Повторите попытку или используйте Cookie Bridge.';
    },
  };

  function safeResumeUrl(url) {
    return url === PREFIX + ':bookmarks' ||
      new RegExp('^' + PREFIX + ':(search|forum|topic):').test(String(url || ''));
  }
  function redirectTo(p, state, stateParams) {
    return p.redirect(PREFIX + ':' + state + ':' + encodeURIComponent(JSON.stringify(stateParams)));
  }

  //  A page that got no response at all is said so, not shown as an empty one.
  function networkWarning(p) {
    p.appendItem('', 'separator', {
      title: new RichText(coloredStr('нет связи с RuTracker: откройте страницу снова, чтобы повторить', red)),
    });
  }

  /*
   * A page list loaded page by page: url is the first page, size the
   * entries per page, fetch(url, n) loads page n (counted from the url's
   * start=), render(result, n) adds its
   * items and returns false to stop, resume(start) is the route back to the
   * page whose start= is given ('' for none). A Clearance Refresh that
   * brings back a guest page means the Session is gone: Password Login,
   * then back to that page.
   */
  function paged(p, url, size, fetch, render, resume) {
    var start = /[?&]start=([0-9]+)/.exec(url);
    var n = start ? Math.floor(start[1] / size) : 0;
    function loader() {
      p.loading = true;
      var result = fetch(url, n + 1);
      p.loading = false;
      //  No response, or the challenge again, is not a guest page: a
      //  warning shows, not Password Login.
      if (result.clearanceRefreshed && result.challenge) {
        p.appendItem('', 'separator', {title: new RichText(coloredStr('Cloudflare не пропустил и после обновления проверки. ' + ELSEWHERE, red))});
        return p.haveMore(false);
      }
      if (result.clearanceRefreshed && !result.user && !result.network) {
        var at = /[?&]start=([^&]+)/.exec(url);
        redirectTo(p, 'login', {showAuth: false, resumeUrl: resume(at ? at[1] : '')});
        return p.haveMore(false);
      }
      n++;
      if (render(result, n) === false || !result.next) return p.haveMore(false);
      url = result.next;
      return p.haveMore(true);
    }
    loader();
    p.asyncPaginator = loader;
  }

  /* ---- start ---------------------------------------------------------- */

  new page.Route(PREFIX + ':start', function (p) {
    if (!config.tosaccepted) {
      if (popup.message(TOS, true, true)) {
        config.acceptTerms();
      }
      else {
        p.error('Условия не приняты. Плагин отключен.');
        return;
      }
    }
    p.loading = true;
    setup(p, TTL);
    p.type = 'directory';
    var s = ctx.session;
    s.onOpen();
    var index = catalog.index();
    //  Read after the requests: a Forget during either has dropped the Clearance.
    var hasClearance = clearance && clearance.active();
    p.loading = false;
    if (s.active()) {
      p.appendItem('', 'separator', {
        title: new RichText(coloredStr(s.text(), s.status() === 'authenticated' ? green : orange)),
      });
    }
    if (s.status() === 'network_error' || index.network) networkWarning(p);
    //  The account of the Active Session; without one, what the site shows
    //  for the cookies Movian's own jar sends (an earlier login).
    var signedIn = s.active() || !!index.user;
    var user = s.user() || index.user || '?';
    var passwordLogin = PREFIX + ':login:' + encodeURIComponent(JSON.stringify({showAuth: false}));
    if (!signedIn) {
      if (config.startAuth && !hasClearance) {
        redirectTo(p, 'login', {showAuth: false});
        return;
      }
      p.appendItem(passwordLogin, 'directory', {
        title: new RichText(coloredStr('Войти на ' + TTL, red)),
        icon: icon.logo,
      });
    }
    else {
      //  A plain label: RuTracker never ends a session on logout (#3), so
      //  there is no action to offer here. Forget is the way out.
      p.appendItem('', 'separator', {
        title: new RichText(coloredStr('Пользователь [ ' + user + ' ]' + (s.active() ? '' : ' (сессия Movian)'), gray)),
      });
    }
    p.appendItem(PREFIX + ':search:0:', 'search', {title: 'Поиск на ' + client.baseUrl});
    //  Needs a signed-in index page: a checked Session with
    //  a failed index is not enough, the bookmarks would load over no network.
    if (index.user) {
      p.appendItem(PREFIX + ':bookmarks', 'directory', {
        title: new RichText('Избранное'),
        icon: icon.bookmarks,
      });
    }
    index.forums.forEach(function (f) {
      p.appendItem(PREFIX + ':forum:' + f.id + ':0:' + encodeURIComponent(f.title), 'directory', {
        title: new RichText(f.title),
        icon: icon.folder,
      });
    });
    if (signedIn || hasClearance) {
      //  What stays valid is said in the item and in the result (see :forget).
      var sessionKept = s.active() || signedIn;
      var forgetTitle = !sessionKept ? 'Забыть Cloudflare clearance' :
        (hasClearance ? 'Забыть сессию и Cloudflare clearance' : 'Забыть сессию') +
        ' (на сайте она останется действующей' + (s.source() === 'bridge' ? ', и в вашем браузере тоже' : '') + ')';
      p.appendItem(PREFIX + ':forget', 'directory', {
        title: new RichText(coloredStr(forgetTitle, gray)),
        icon: icon.exit,
      });
    }
    if (signedIn) {
      p.appendItem(passwordLogin, 'directory', {
        title: new RichText(coloredStr('Войти по паролю (сменить способ входа)', gray)),
        icon: icon.logo,
      });
    }
    if (clearance.available()) {
      p.appendItem(PREFIX + ':refreshclearance', 'directory', {
        title: new RichText(coloredStr('Обновить проверку Cloudflare', gray)),
        icon: icon.logo,
      });
    }
  });

  /* ---- search --------------------------------------------------------- */

  if (config.msearch) {
    new page.Searcher(PREFIX, LOGO, function (p, query) {
      p.metadata.background = icon.background;
      p.metadata.title = new RichText(TTL + ': ' + query);
      p.type = 'directory';
      p.model.contents = 'list';
      p.entries = 0;
      p.loading = true;
      //  Movian's global search: no Cloudflare window over the user's search.
      var result = catalog.search(client.url.search(query), true);
      p.loading = false;
      if (!result.loaded) {
        p.appendItem('', 'separator', {title: 'Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare)'});
        return;
      }
      result.topics.forEach(function (row, i) {
        appendTopic(p, row, i + 1, 'Добавлен: ');
        p.entries++;
      });
      p.appendItem(PREFIX + ':search:0:' + query, 'directory', {
        title: new RichText('Продолжить поиск'),
        icon: icon.arrow,
      });
      if (p.entries == 3)
        p.entries = p.entries + 1;
      p.loading = false;
    });
  }

  //  The forum id has no colon; the query may ("Star Trek: Discovery").
  new page.Route(PREFIX + ':search:([^:]*):(.*)', function (p, forumId, query) {
    var routeForumId = forumId;
    if (!forumId || (forumId === '0'))
      forumId = '-1';
    var topicCount = 0;
    p.metadata.background = icon.background;
    p.metadata.title = new RichText(TTL + ': ' + query);
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    //  A search resumes at its first page: the pager links' search_id
    //  belongs to the old Session.
    paged(p, client.url.search(query, forumId), 50, function (url) {
      return catalog.search(url);
    }, function (result, n) {
      if (!topicCount && !result.topics.length) {
        nothingFound(result.loaded);
        return false;
      }
      if (!result.loaded) {
        p.appendItem('', 'separator', {title: 'Следующая страница не загружена: сайт не вернул страницу'});
        return false;
      }
      if (result.topics.length) {
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(n, gray))});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Добавлен: ');
        p.entries++;
      });
    }, function () {
      return PREFIX + ':search:' + routeForumId + ':' + query;
    });
    //  The site matches whole words: "dis" finds nothing, "dis*" finds
    //  "Discovery". Offer that instead of an empty page.
    function nothingFound(loaded) {
      if (!loaded) return p.error('Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare). Если CEF недоступен, передайте сессию через Cookie Bridge.');
      p.appendItem('', 'separator', {title: 'Ничего не найдено'});
      if (/[^\s*]$/.test(query))
        p.appendItem(PREFIX + ':search:' + forumId + ':' + query + '*', 'directory', {
          title: 'Искать начало слова: ' + query + '*',
          icon: icon.arrow,
        });
    }
  });

  /* ---- lists ---------------------------------------------------------- */

  new page.Route(PREFIX + ':bookmarks', function (p) {
    var topicCount = 0;
    setup(p, 'Избранное');
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    paged(p, client.url.bookmarks, 50, catalog.bookmarks, function (result, n) {
      if (!result.loaded) {
        if (n === 1) p.error('Закладки не загружены: сайт не вернул страницу закладок (сеть, Cloudflare или вход не выполнен)');
        else p.appendItem('', 'separator', {title: 'Следующая страница не загружена: сайт не вернул страницу'});
        return false;
      }
      if (result.topics.length) {
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(n, gray))});
      }
      else if (n === 1) {
        p.appendItem('', 'separator', {title: 'Закладок нет'});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Посл. сообщение: ');
        p.entries++;
      });
    }, function () {
      return PREFIX + ':bookmarks';
    });
  });

  new page.Route(PREFIX + ':forum:(.*):(.*):(.*)', function (p, forumId, forumPage, forumTitle) {
    var pageStart = parseInt(forumPage, 10) || 0;
    var itemCount = 0;
    var topicCount = 0;
    var title = decodeURIComponent(forumTitle);
    setup(p, new RichText(title));
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    paged(p, client.url.subforum(forumId) + (pageStart ? '&start=' + pageStart : ''), 50, catalog.forum, function (result, n) {
      if (result.network) return networkWarning(p);
      if (n === 1) {
        p.appendItem(PREFIX + ':search:' + forumId + ':', 'search', {title: 'Поиск в разделе ' + title});
        if (result.subforums.length) p.appendItem('', 'separator', {title: 'Форумы'});
        result.subforums.forEach(function (f) {
          itemCount++;
          p.appendItem(PREFIX + ':forum:' + f.id + ':0:' + encodeURIComponent(f.title), 'directory', {
            title: new RichText(itemCount + ' | ' + f.title),
            icon: icon.folder,
          });
        });
      }
      if (result.topics.length) {
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(n, gray))});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Посл. сообщение: ');
        p.entries++;
      });
    }, function (start) {
      return PREFIX + ':forum:' + forumId + ':' + (start || forumPage) + ':' + forumTitle;
    });
  });

  /* ---- topic ---------------------------------------------------------- */

  new page.Route(PREFIX + ':topic:([^:]*):([^:]*)(?::([0-9]+))?', function (p, topicId, topicTitle, topicStart) {
    var pageStart = parseInt(topicStart, 10) || 0;
    var title = decodeURIComponent(topicTitle);
    setup(p);
    p.metadata.title = new RichText(title);
    p.type = 'directory';
    p.model.contents = 'list';

    //  The release item for the torrent or magnet link of the first post;
    //  a passive item with the post when that link is missing.
    function appendRelease(post, type) {
      //  Only direct image links; Movian decodes webp natively.
      var image = /\.(jpg|jpe|jpeg|jfif|png|bmp|dib|svg|gif|webp)/i.test(post.image) ? post.image : icon.icon;
      var meta = {
        title: new RichText(title),
        duration: type === 'torrent' ? 'T' : 'M',
        icon: image,
        backdrops: [{url: image}, {url: icon.logo}, {url: ''}],
        tagline: new RichText(title),
        description: new RichText(post.text),
      };
      var link = type === 'torrent' ? post.torrent : post.magnet;
      if (!link) {
        delete meta.duration;
        p.appendPassiveItem(config.list, null, meta);
      }
      else {
        p.appendItem(type === 'torrent' ? PREFIX + ':torrent:' + encodeURIComponent(link) : 'torrent:browse:' + decodeURIComponent(link), config.list, meta);
      }
    }

    //  Core opens a plain link itself, without the Core-held clearance; the
    //  torrent route fetches through the plugin client instead.
    function appendLink(url, name) {
      if (/^https:\/\//i.test(url) && /dl\.php/.test(url)) url = PREFIX + ':torrent:' + encodeURIComponent(url);
      p.appendItem(url, config.list, {
        title: name,
        icon: icon.icon,
        backdrops: [{url: icon.icon}, {url: icon.logo}, {url: ''}],
        description: new RichText(title),
      });
    }

    //  A topic page holds 30 posts.
    paged(p, client.url.topic(topicId) + (pageStart ? '&start=' + pageStart : ''), 30, function (url, n) {
      return catalog.topic(url, n === 1);
    }, function (t, n) {
      if (t.network) return networkWarning(p);
      if (n === 1) {
        p.appendItem('', 'separator', {title: 'Торренты:'});
        appendRelease(t.post, 'torrent');
        if (t.download) appendLink(t.download, 'Торрент-ссылка');
        if (t.dl) appendLink(t.dl, 'Торрент-ссылка');
        appendRelease(t.post, 'magnet');
        if (t.magnet) appendLink(t.magnet, 'Магнет-ссылка');
        p.appendItem('', 'separator', {title: new RichText('Сиды: ' + coloredStr(t.seeders, green) + ' | Личи: ' + coloredStr(t.leechers, red))});
        //  The query is the title's name: without its [tags], cut at the first
        //  ( / | \, without tags. A title that leaves nothing gets no shortcuts.
        var query = title.replace(/\[[^\]]*\]/g, '').replace(/[(\/|\\].*$/, '').replace(/<.*?>/g, '').trim();
        var plain = query.replace(/:/g, '').trim();
        if (plain) {
          p.appendItem('', 'separator', {title: 'Поиск:'});
          [
            [PREFIX + ':search:0:' + plain, 'Найти в плагине'],
            ['search:' + plain, 'Найти в мовиан'],
            ['Rutube:search:' + plain, 'Найти на Rutube'],
            ['youtube:search:' + plain, 'Найти на YouTube'],
            ['Collaps:search:' + query, 'Найти на Collaps'],
            ['HDVB:search:' + query, 'Найти на HDVB'],
            ['KPID:search:' + plain, 'Найти на KPID'],
          ].forEach(function (s) {
            p.appendItem(s[0], 'directory', {title: s[1], icon: icon.arrow});
          });
        }
      }
      if (t.comments.length) {
        p.appendItem('', 'separator', {title: new RichText('Комментарии ' + colorStr(n, gray))});
      }
      t.comments.forEach(function (text) {
        p.appendPassiveItem(config.list, null, {
          title: new RichText(text),
          icon: icon.logo,
          backdrops: [{url: icon.logo}, {url: ''}],
          description: new RichText(text),
        });
      });
    }, function (start) {
      return PREFIX + ':topic:' + topicId + ':' + topicTitle + (start ? ':' + start : topicStart ? ':' + topicStart : '');
    });
  });

  new page.Route(PREFIX + ':torrent:(.*)', function (p, dlHref) {
    setup(p);
    var res = client.torrent(decodeURIComponent(dlHref));
    if (res.error) {
      p.error(res.error === 'network' ? 'Не удалось скачать торрент: сетевая ошибка' :
        'Не удалось скачать торрент: сайт вернул страницу вместо файла (нужен вход?)');
      return;
    }
    p.redirect('torrent:browse:data:application/x-bittorrent;base64,' + Duktape.enc('base64', res.bytes));
  });

  /* ---- Cloudflare clearance (Movian Go) ------------------------------- */

  new page.Route(PREFIX + ':refreshclearance', function (p) {
    setup(p, 'Проверка Cloudflare');
    var res = clearance.refresh({title: 'Cloudflare: решите challenge и закройте окно', force: true});
    if (res.status === 'ok') {
      p.redirect(PREFIX + ':start');
      return;
    }
    p.error(CLEARANCE_ERRORS[res.status] ? CLEARANCE_ERRORS[res.status]() : CLEARANCE_ERRORS.empty());
  });

  /* ---- Password Login ------------------------------------------------- */

  new page.Route(PREFIX + ':login:(.*)', function (p, options) {
    setup(p, 'Вход на ' + TTL);
    options = JSON.parse(decodeURIComponent(options));
    //  After a Forget the first sign-in always shows Movian's login dialog,
    //  even with saved credentials: Movian would take them silently (#22).
    if (ctx.session.forgotten()) options.showAuth = true;
    if (!clearance.active() && clearance.available()) {
      var acquired = clearance.refresh({title: 'Cloudflare: ждите закрытия окна после получения clearance'});
      if (acquired.status !== 'ok') {
        p.error(CLEARANCE_ERRORS[acquired.status] ? CLEARANCE_ERRORS[acquired.status]() :
          CLEARANCE_ERRORS.empty());
        return;
      }
    }
    for (;;) {
      var credentials = popup.getAuthCredentials(TTL + ' (' + client.baseUrl + ')', 'Требуется авторизация, введите логин и пароль', options.showAuth);
      if (credentials.rejected) return;
      if (credentials) {
        p.loading = true;
        var result = ctx.auth.login(credentials.username, credentials.password);
        p.loading = false;
        if (LOGIN_ERRORS[result.status]) {
          p.error(LOGIN_ERRORS[result.status](result));
          return;
        }
        if (result.status === 'captcha') {
          redirectTo(p, 'captcha', {captcha: result.captcha, username: credentials.username, resumeUrl: options.resumeUrl || ''});
          return;
        }
        options.showAuth = result.status === 'failed';
        if (!options.showAuth) break;
      }
      options.showAuth = true;
    }
    p.redirect(safeResumeUrl(options.resumeUrl) ? options.resumeUrl : PREFIX + ':start');
  });

  //  The Server Logout was removed (#3): RuTracker keeps the session valid.
  //  The route stays for old bookmarks, and posts nothing.
  new page.Route(PREFIX + ':logout', function (p) {
    p.redirect(PREFIX + ':start');
  });

  //  Built-in Browser Login was removed (#22): its route stays for old
  //  bookmarks, and opens no window.
  new page.Route(PREFIX + ':browserlogin', function (p) {
    p.redirect(PREFIX + ':start');
  });

  //  "Forget": the Active Session goes, and the Core Jar's login is hidden
  //  until a new one is Active (session.js). The browser's cf_clearance and
  //  the Core record of the clearance are deleted; the browser's session
  //  cookies are not (no Session comes from the browser any more). RuTracker
  //  keeps the session valid, and the result says so.
  new page.Route(PREFIX + ':forget', function (p) {
    setup(p, 'Забыть сессию ' + TTL);
    var source = ctx.session.source();
    ctx.session.forget();
    clearance.forget();
    popup.notify('Сессия забыта. На сайте RuTracker она остаётся действующей' +
      (source === 'bridge' ? ', и в вашем браузере тоже' : '') + '.', 5);
    p.redirect(PREFIX + ':start');
  });

  //  The Login Captcha in views/login-captcha.view: the sign-in form again,
  //  with the site's picture. The view binds metadata.username, password
  //  and captchaCode and delivers "captchaSubmit" or "captchaCancel" (Movian
  //  turns "submit" / "cancel" into its own actions). The password never
  //  goes into a route: the form signs in itself.
  new page.Route(PREFIX + ':captcha:(.*)', function (p, state) {
    state = JSON.parse(decodeURIComponent(state));
    setup(p, 'Вход на ' + TTL);
    p.type = 'raw';
    p.metadata.glwview = ctx.path + 'views/login-captcha.view';
    p.metadata.username = state.username || '';
    function ask(captcha) {
      state.captcha = captcha;
      p.metadata.captchaImage = 'https://' + captcha.image;
      p.metadata.captchaMessage = captcha.message;
      p.metadata.password = '';
      p.metadata.captchaCode = '';
    }
    ask(state.captcha);
    p.onEvent('captchaSubmit', function () {
      var username = String(p.metadata.username || '');
      var password = String(p.metadata.password || '');
      var code = String(p.metadata.captchaCode || '');
      if (!username || !password || !code) return;
      //  An error page keeps the metadata, so the password must not stay in it.
      p.metadata.password = '';
      p.loading = true;
      var result = ctx.auth.login(username, password, {sid: state.captcha.sid, field: state.captcha.field, value: code});
      p.loading = false;
      if (result.status === 'captcha') return ask(result.captcha);
      if (LOGIN_ERRORS[result.status]) return p.error(LOGIN_ERRORS[result.status](result));
      if (result.status === 'failed') return redirectTo(p, 'login', {showAuth: true, resumeUrl: state.resumeUrl});
      p.redirect(safeResumeUrl(state.resumeUrl) ? state.resumeUrl : PREFIX + ':start');
    });
    p.onEvent('captchaCancel', function () {
      p.metadata.password = '';
      redirectTo(p, 'login', {showAuth: true, resumeUrl: state.resumeUrl});
    });
  });

  /* ---- item hook ------------------------------------------------------ */

  if (config.isearch) {
    require('movian/itemhook').create({
      title: 'Поиск на RuTracker.org',
      itemtype: 'video',
      handler: function (obj, nav) {
        var t = obj.metadata.title.toString();
        t = t.replace(/<.+?>/g, '').replace(/\[.+?\]/g, '');
        nav.openURL(PREFIX + ':search:0:' + t);
      }
    });
  }
};
