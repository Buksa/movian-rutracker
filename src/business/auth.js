/*
 * Password Login: RuTracker's login form with username and password. The
 * Set-Cookie session of the answer is a Candidate Session for the Session
 * Coordinator; the Clearance the form went out with stays the Clearance's.
 */

exports.create = function (client, parser, session) {
  return {
    //  captcha: {sid, field, value} when answering a captcha.
    //  Returns 'ok' once the Candidate Session passed its Session Check;
    //  a failure never replaces an existing Active Session.
    login: function (username, password, captcha) {
      if (!client.host) return {status: 'insecure'};
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
      if (!redirected || parser.loginFailed(res.text)) return {status: 'failed'};
      var check = session.submit({source: 'password', host: client.host, cookie: res.cookie, ua: res.clearance ? res.clearance.ua : client.defaultUA});
      //  A Forget, Clear or newer sign-in meanwhile: this login is not wanted any more.
      if (check.status === 'cancelled') return {status: 'cancelled'};
      return check.status === 'authenticated' ? {status: 'ok'} : {status: 'unverified', check: check.status};
    },
  };
};
