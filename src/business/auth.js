/*
 * Legacy RuTracker login with username and password (the fallback when no
 * browser session is bridged). Asking the user is the UI's job; this only
 * talks to the site and reports what happened.
 */

exports.create = function (client, parser) {
  return {
    //  captcha: {sid, field, value} when answering a captcha.
    //  Returns {status, captcha}: 'ok' | 'failed' | 'captcha' (with
    //  {image, sid, field}) | 'network' | 'challenge'.
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
      var res = client.login(fields);
      if (!res) return {status: 'network'};
      if (res.challenge) return {status: 'challenge'};
      var asked = parser.captcha(res.text);
      if (asked) return {status: 'captcha', captcha: asked};
      //  A good login is answered with a redirect (the request does not
      //  follow it); the form again, or any other page, is not a login.
      var redirected = res.status >= 300 && res.status < 400;
      return {status: redirected && !parser.loginFailed(res.text) ? 'ok' : 'failed'};
    },

    logout: function () {
      client.logout();
    },
  };
};
