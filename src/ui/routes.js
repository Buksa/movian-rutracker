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
 * ctx: {id, title, path, logo, config, catalog, auth, client, bridge}
 *   config  - live settings values (see src/ui/settings.js)
 *   bridge  - {status, user, text()} of the Cookie Bridge session
 */
exports.register = function (ctx) {
  var PREFIX = ctx.id;
  var TTL = ctx.title;
  var LOGO = ctx.logo;
  var config = ctx.config;
  var catalog = ctx.catalog;
  var client = ctx.client;
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

  function redirectTo(p, state, stateParams) {
    return p.redirect(PREFIX + ':' + state + ':' + encodeURIComponent(JSON.stringify(stateParams)));
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
    p.model.contents = 'list';
    var b = ctx.bridge;
    if (b.active() || /^(authenticated|rejected|challenge|network_error)$/.test(b.status())) {
      p.appendItem('', 'separator', {
        title: new RichText(coloredStr(b.text(), b.status() === 'authenticated' ? green : orange)),
      });
    }
    var index = catalog.index();
    p.loading = false;
    if (!index.user) {
      if (config.startAuth) {
        redirectTo(p, 'login', {showAuth: false});
        return;
      }
      p.appendItem(PREFIX + ':login:' + encodeURIComponent(JSON.stringify({showAuth: false})), 'directory', {
        title: new RichText(coloredStr('Войти на ' + TTL, red)),
        icon: icon.logo,
      });
    }
    else {
      p.appendItem(PREFIX + ':logout:true:null:null', 'directory', {
        title: new RichText(coloredStr('Пользователь [ ' + index.user + ' ]', gray)),
        icon: icon.logo,
      });
    }
    p.appendItem(PREFIX + ':search:0:', 'search', {title: 'Поиск на ' + client.baseUrl});
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
    if (index.user) {
      p.appendItem(PREFIX + ':logout:true:null:null', 'directory', {
        title: new RichText(coloredStr('Выйти из аккаунта ' + index.user, red)),
        icon: icon.exit,
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
      var result = catalog.search(client.url.search(query));
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
    if (!forumId || (forumId === '0'))
      forumId = '-1';
    var url = client.url.search(query, forumId);
    var pageNum = 0;
    var topicCount = 0;
    p.metadata.background = icon.background;
    p.metadata.title = new RichText(TTL + ': ' + query);
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    loader();
    p.asyncPaginator = loader;
    function loader() {
      p.loading = true;
      var result = catalog.search(url);
      p.loading = false;
      if (!topicCount && !result.topics.length) {
        nothingFound(result.loaded);
        return p.haveMore(false);
      }
      if (!result.loaded) {
        p.appendItem('', 'separator', {title: 'Следующая страница не загружена: сайт не вернул страницу'});
        return p.haveMore(false);
      }
      if (result.topics.length) {
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(pageNum + 1, gray))});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Добавлен: ');
        p.entries++;
      });
      if (!result.next) return p.haveMore(false);
      url = result.next;
      pageNum++;
      return p.haveMore(true);
    }
    //  The site matches whole words: "dis" finds nothing, "dis*" finds
    //  "Discovery". Offer that instead of an empty page.
    function nothingFound(loaded) {
      if (!loaded) return p.error('Поиск не выполнен: сайт не вернул результаты (сеть или проверка Cloudflare)');
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
    var url = client.url.bookmarks;
    var pageNum = 0;
    var topicCount = 0;
    setup(p, 'Избранное');
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    loader();
    p.asyncPaginator = loader;
    function loader() {
      p.loading = true;
      var result = catalog.bookmarks(url);
      p.loading = false;
      pageNum++;
      if (!result.loaded) {
        if (pageNum === 1) p.error('Закладки не загружены: сайт не вернул страницу закладок (сеть, Cloudflare или вход не выполнен)');
        else p.appendItem('', 'separator', {title: 'Следующая страница не загружена: сайт не вернул страницу'});
        return p.haveMore(false);
      }
      if (result.topics.length) {
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(pageNum, gray))});
      }
      else if (pageNum === 1) {
        p.appendItem('', 'separator', {title: 'Закладок нет'});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Посл. сообщение: ');
        p.entries++;
      });
      if (!result.next) return p.haveMore(false);
      url = result.next;
      return p.haveMore(true);
    }
  });

  new page.Route(PREFIX + ':forum:(.*):(.*):(.*)', function (p, forumId, forumPage, forumTitle) {
    var url = client.url.subforum(forumId);
    var pageNum = 0;
    var itemCount = 0;
    var topicCount = 0;
    var title = decodeURIComponent(forumTitle);
    setup(p, new RichText(title));
    p.type = 'directory';
    p.model.contents = 'list';
    p.entries = 0;
    loader();
    p.asyncPaginator = loader;
    function loader() {
      p.loading = true;
      var result = catalog.forum(url);
      p.loading = false;
      pageNum++;
      if (pageNum === 1) {
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
        p.appendItem('', 'separator', {title: new RichText('Темы ' + colorStr(pageNum, gray))});
      }
      result.topics.forEach(function (row) {
        appendTopic(p, row, ++topicCount, 'Посл. сообщение: ');
        p.entries++;
      });
      if (!result.next) return p.haveMore(false);
      url = result.next;
      return p.haveMore(true);
    }
  });

  /* ---- topic ---------------------------------------------------------- */

  new page.Route(PREFIX + ':topic:(.*):(.*)', function (p, topicId, topicTitle) {
    var url = client.url.topic(topicId);
    var title = decodeURIComponent(topicTitle);
    var pageNum = 0;
    setup(p);
    p.metadata.title = new RichText(title);
    p.type = 'directory';
    p.model.contents = 'list';
    loader();
    p.asyncPaginator = loader;

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

    function appendLink(url, name) {
      p.appendItem(url, config.list, {
        title: name,
        icon: icon.icon,
        backdrops: [{url: icon.icon}, {url: icon.logo}, {url: ''}],
        description: new RichText(title),
      });
    }

    function loader() {
      p.loading = true;
      var t = catalog.topic(url, pageNum === 0);
      p.loading = false;
      pageNum++;
      if (pageNum === 1) {
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
        p.appendItem('', 'separator', {title: new RichText('Комментарии ' + colorStr(pageNum, gray))});
      }
      t.comments.forEach(function (text) {
        p.appendPassiveItem(config.list, null, {
          title: new RichText(text),
          icon: icon.logo,
          backdrops: [{url: icon.logo}, {url: ''}],
          description: new RichText(text),
        });
      });
      if (!t.next) return p.haveMore(false);
      url = t.next;
      return p.haveMore(true);
    }
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

  /* ---- legacy login --------------------------------------------------- */

  new page.Route(PREFIX + ':login:(.*)', function (p, options) {
    setup(p, 'Вход на ' + TTL);
    options = JSON.parse(decodeURIComponent(options));
    while (1) {
      var credentials = popup.getAuthCredentials(TTL + ' (' + client.baseUrl + ')', 'Требуется авторизация, введите логин и пароль', options.showAuth);
      if (credentials.rejected) return;
      if (credentials) {
        p.loading = true;
        var result = ctx.auth.login(credentials.username, credentials.password, options.captchaSid ?
          {sid: options.captchaSid, field: options.capCodeName, value: options.captchaValue} : null);
        p.loading = false;
        if (result.status === 'network' || result.status === 'challenge') {
          p.error(result.status === 'network' ? 'Вход не выполнен: сетевая ошибка' :
            'Вход не выполнен: сайт требует проверку Cloudflare. Войдите в браузере и передайте сессию через Cookie Bridge.');
          return;
        }
        if (result.status === 'captcha') {
          p.redirect(PREFIX + ':captcha:' + encodeURIComponent(result.captcha.image) + ':' + result.captcha.sid + ':' + result.captcha.field);
          return;
        }
        options.showAuth = result.status === 'failed';
        if (!options.showAuth) {
          //  Bridge cookies would override the new login (inspector cookies
          //  beat the core cookie jar for the same name).
          if (ctx.bridge.active()) ctx.bridge.clear();
          break;
        }
      }
      options.showAuth = true;
    }
    if (options.topicId && options.topicId !== 'null') {
      p.redirect(PREFIX + ':topic:' + options.topicId + ':' + options.topicTitle);
    }
    else p.redirect(PREFIX + ':start');
  });

  new page.Route(PREFIX + ':logout:(.*):(.*):(.*)', function (p, showAuth, redirectTopicId, redirectTopicTitle) {
    setup(p, 'Выход из ' + TTL);
    //  A bridged session belongs to the user's browser: drop it here first,
    //  so the logout request carries only the plugin's own session and the
    //  browser stays logged in.
    if (ctx.bridge.active()) ctx.bridge.clear();
    ctx.auth.logout();
    p.loading = false;
    if (config.startAuth)
      redirectTo(p, 'login', {
        showAuth: showAuth === 'true',
        topicId: redirectTopicId,
        topicTitle: redirectTopicTitle,
      });
    else
      p.redirect(PREFIX + ':start');
  });

  new page.Route(PREFIX + ':captchalogin:(.*):(.*):(.*)', function (p, image, capSid, capCodeName) {
    image = decodeURIComponent(image);
    if (!/^https?:\/\//.test(image)) image = 'https://' + image;
    setup(p, 'Ввод капчи для входа на ' + TTL);
    p.type = 'directory';
    p.model.contents = 'list';
    p.appendItem(PREFIX + ':start', 'video', {
      title: new RichText('Капча'),
      icon: image,
      backdrops: [{url: image}],
      description: new RichText('Введите капчу с картинки'),
    });
    var captchaValue = popup.textDialog('Введите капчу с картинки', true);
    if (captchaValue && !captchaValue.rejected && captchaValue.input) {
      redirectTo(p, 'login', {
        showAuth: true,
        captchaSid: capSid,
        captchaValue: captchaValue.input,
        capCodeName: capCodeName,
      });
    }
    else {
      redirectTo(p, 'login', {showAuth: true});
    }
  });

  new page.Route(PREFIX + ':captcha:(.*):(.*):(.*)', function (p, image, capSid, capCodeName) {
    image = decodeURIComponent(image);
    if (!/^https?:\/\//.test(image)) image = 'https://' + image;
    setup(p, 'Ввод капчи для входа на ' + TTL);
    p.type = 'directory';
    p.model.contents = 'list';
    p.appendItem(PREFIX + ':captchalogin:' + image + ':' + capSid + ':' + capCodeName, 'video', {
      title: new RichText('Нажмите, чтобы ввести капчу'),
      icon: image,
      backdrops: [{url: image}],
      description: new RichText('Запомните капчу с картинки'),
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
