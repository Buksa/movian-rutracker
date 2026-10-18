/*
 * Legacy RuTracker login with username and password (the fallback when no
 * browser session is bridged). Asking the user is the UI's job; this only
 * talks to the site and reports what happened.
 */

exports.create = function (client, parser) {
  return {
    //  captcha: {sid, field, value} when answering a captcha.
    //  Returns {status: 'ok' | 'failed' | 'captcha', captcha: {image, sid, field}}.
    login: function (username, password, captcha) {
      var fields = {
        'login_username': username,
        'login_password': password,
        'autologin': 'on',
        'login': encodeURIComponent('Вход'),
      };
      if (captcha) {
        fields['cap_sid'] = captcha.sid;
        fields[captcha.field] = captcha.value;
      }
      var text = client.login(fields);
      var asked = parser.captcha(text);
      if (asked) return {status: 'captcha', captcha: asked};
      return {status: parser.loginFailed(text) ? 'failed' : 'ok'};
    },

    logout: function () {
      client.logout();
    },
  };
};
