const crypto = require('node:crypto');

function login(event, context) {
  if (!event || event.action !== 'login') return { ok: false, code: 'ACTION_INVALID', message: '不支持的登录操作' };
  // 身份只取微信云调用上下文，绝不接受客户端声称的 openid/userId。
  if (!context || typeof context.OPENID !== 'string' || !context.OPENID.trim() || typeof context.APPID !== 'string' || !context.APPID.trim()) {
    return { ok: false, code: 'UNAUTHENTICATED', message: '无法验证微信账号，请在微信中重新打开小程序' };
  }
  const id = crypto.createHash('sha256').update(context.APPID + ':' + context.OPENID).digest('hex');
  return { ok: true, user: { id } };
}

module.exports = { login };
