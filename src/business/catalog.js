/*
 * Catalog: what the plugin shows - forums, topic lists, search results and
 * a topic's releases - as plain data. Fetching and parsing go through the
 * API layer; turning the data into Movian items is the UI's job.
 */

//  Index forums with video (and other media) content, by exact title.
var MEDIA_FORUMS = /^(Наше кино|Зарубежное кино|Арт-хаус и авторское кино|Театр|DVD Video|HD Video|UHD Video|3D\/Стерео Кино, Видео, TV и Спорт|Мультфильмы|Мультсериалы|Аниме|Русские сериалы|Зарубежные сериалы|Зарубежные сериалы \(HD Video\)|Сериалы Латинской Америки, Турции и Индии|Азиатские сериалы|СМИ|Вера и религия|Документальные фильмы и телепередачи|Документальные \(HD Video\)|Развлекательные телепередачи и шоу, приколы и юмор|[IVX]+ (Летние|Зимние) Олимпийские игры [0-9][0-9][0-9][0-9]|Спортивные турниры, фильмы и передачи|.*Футбол|.*Баскетбол|.*Хоккей|Рестлинг|Видеоуроки и обучающие интерактивные DVD|Боевые искусства \(Видеоуроки\)|Компьютерные видеоуроки и обучающие интерактивные DVD|Радиоспектакли, история, мемуары|Фантастика, фэнтези, мистика, ужасы, фанфики|Художественная литература|Религии|Прочая литература|Фильмы и передачи по авто\/мото|Классическая и современная академическая музыка|Фольклор, Народная и Этническая музыка|New Age, Relax, Meditative.*Flamenco|Рэп, Хип-Хоп, R.*n.*B|Reggae, Ska, Dub|Саундтреки, караоке и мюзиклы|Шансон, Авторская и Военная песня|Лейбл- и сцен-паки. Неофициальные сборники и ремастеринги. AI-музыка|Отечественная поп-музыка|Зарубежная поп-музыка|Eurodance, Disco, Hi-NRG|Зарубежный джаз|Зарубежный блюз|Отечественный джаз и блюз|Зарубежный Rock|Зарубежный Metal|Зарубежные Alternative, Punk, Independent|Отечественный Rock, Metal|Trance, Goa Trance, Psy-Trance, PsyChill, Ambient, Dub|House, Techno, Hardcore, Hardstyle, Jumpstyle|Drum.*Bass, Jungle, Breakbeat, Dubstep, IDM, Electro|Chillout, Lounge, Downtempo, Trip-Hop|Traditional Electronic, Ambient, Modern Classical, Electroacoustic, Experimental|Industrial, Noise, EBM, Dark Electro, Aggrotech, Cyberpunk, Synthpop, New Wave|Hi-Res форматы, оцифровки|Архив \(Hi-Res форматы, оцифровки\)|Для общения \(Hi-Res, оцифровки\)|Hi-Res stereo и многоканальная музыка|Оцифровки с аналоговых носителей|Неофициальные конверсии цифровых форматов|Музыкальное SD видео|Музыкальное DVD видео|Неофициальные DVD видео|Музыкальное HD видео|Некондиционное музыкальное видео \(Видео, DVD видео, HD видео\)|Видео для консолей|Игровое видео|Видео для мобильных устройств|Видео|Видео HD|Аудио|Разное \(раздачи\)|Архив \(Общий\))$/;

exports.create = function (client, parser) {
  function next(text, containerClass) {
    var href = parser.nextPage(parser.parse(text), containerClass);
    return href ? client.url.resolve(href) : null;
  }

  //  Forum and bookmark lists also catch pager links titled "1".
  function forumTopics(text) {
    return parser.topicRows(text, 'forum').filter(function (row) { return row.title !== '1'; });
  }

  return {
    //  {user, forums}: user is the logged-in account name or null.
    index: function () {
      var text = client.page(client.url.index);
      return {
        user: parser.loginName(text),
        forums: parser.subforums(text).filter(function (f) { return MEDIA_FORUMS.test(f.title); }),
      };
    },

    forum: function (url) {
      var text = client.page(url);
      return {subforums: parser.subforums(text), topics: forumTopics(text), next: next(text, 'bottom_info')};
    },

    bookmarks: function (url) {
      var text = client.page(url);
      return {topics: forumTopics(text), next: next(text, 'bottom_info')};
    },

    //  loaded: false when the site sent no result page (network, Cloudflare).
    search: function (url) {
      var text = client.page(url);
      return {loaded: parser.searchResults(text), topics: parser.topicRows(text, 'tracker'), next: next(text, 'bottom_info')};
    },

    //  A topic page. On the first page the opening post is the release
    //  (poster, text, torrent/magnet links); later pages are comments only.
    topic: function (url, firstPage) {
      var p = parser.topicPage(client.page(url), firstPage);
      if (p.post.torrent) p.post.torrent = client.url.resolve(p.post.torrent);
      if (p.download) p.download = client.forum + p.download;
      if (p.dl) p.dl = client.forum + p.dl;
      if (p.next) p.next = client.url.resolve(p.next);
      return p;
    },
  };
};
