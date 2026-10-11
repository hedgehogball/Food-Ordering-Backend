'use strict';
const { login } = require('./auth/service');
const { BusinessError } = require('./dining/domain');
const { dishes } = require('./dining/menu');
function identity(headers, appId) {
  const openid = headers['x-wx-openid'];
  const appid = headers['x-wx-appid'];
  // These headers must come through the WeChat gateway. Public ingress is disabled in service settings.
  if (typeof headers['x-wx-source'] !== 'string' || !headers['x-wx-source'] || appid !== appId ||
      typeof openid !== 'string' || !/^[A-Za-z0-9_-]{10,128}$/.test(openid)) {
    throw new BusinessError('UNAUTHENTICATED', '请通过微信小程序访问');
  }
  return { OPENID: openid, APPID: appid };
}
function json(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new BusinessError('INVALID_REQUEST', '请求格式错误');
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65536) throw new BusinessError('INVALID_REQUEST', '提交内容过大');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error();
    return value;
  } catch (_) { throw new BusinessError('INVALID_REQUEST', '请求格式错误'); }
}
function createApp({ dining, takeaway, users, health, appId, operations, roleOf = () => 'customer' }) {
  return async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        await health(); return json(res, 200, { ok: true, service: 'lianjia-order-api', version: '1.0.0' });
      }
      if (!['/api/login', '/api/table-order', '/api/takeaway', '/api/menu', ...(operations ? ['/api/operations'] : [])].includes(req.url)) return json(res, 404, { ok: false, code: 'NOT_FOUND' });
      if (req.method !== 'POST') return json(res, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' });
      const context = identity(req.headers, appId);
      const input = await body(req);
      const account = login({ action: 'login' }, context).user;
      if (req.url === '/api/login') {
        const result = login(input, context);
        if (result.ok) { await users(account.id); result.user.role = roleOf(account.id, context); }
        return json(res, 200, result);
      }
      if (req.url === '/api/menu') return json(res, 200, { ok: true, dishes });
      if (req.url === '/api/operations') return json(res, 200, { ok: true, ...await operations(input, account.id, context) });
      if (req.url === '/api/takeaway') return json(res, 200, { ok: true, ...await takeaway(input, account.id) });
      return json(res, 200, { ok: true, session: await dining(input, context.OPENID) });
    } catch (error) {
      if (error instanceof BusinessError) return json(res, 200, { ok: false, code: error.code, message: error.message });
      // Do not log SQL parameters, OpenIDs, contact details or database credentials.
      console.error('request_failed', { code: /^[A-Z_]+$/.test(error.code || '') ? error.code : 'INTERNAL' });
      if (!res.headersSent) json(res, 503, { ok: false, code: 'SERVICE_UNAVAILABLE', message: '服务暂时不可用，请稍后重试核对订单' });
    }
  };
}
module.exports = { createApp, identity };
