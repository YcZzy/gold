const https = require('https');
const { hmac } = require('./payment');

const APP_ID = 'wx892f2174d0293f28';
let cachedToken;

function request(path, params, body) {
  const url = new URL(path, 'https://api.weixin.qq.com');
  url.search = new URLSearchParams(params).toString();
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {},
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('error', reject);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode !== 200 || (result.errcode && result.errcode !== 0)) {
            reject(Object.assign(Error('wechat-api-error'), { wechatCode: result.errcode }));
          } else resolve(result);
        } catch (_) { reject(Error('wechat-response-invalid')); }
      });
    });
    req.setTimeout(4000, () => req.destroy(Error('wechat-timeout')));
    req.on('error', reject);
    req.end(body);
  });
}

function appKey(env) {
  const key = process.env[env === 1 ? 'XPAY_SANDBOX_APP_KEY' : 'XPAY_PRODUCTION_APP_KEY'];
  if (!key) throw Error('payment-not-configured');
  return key;
}

async function session(code) {
  return request('/sns/jscode2session', {
    appid: APP_ID, secret: process.env.WECHAT_APP_SECRET, js_code: code, grant_type: 'authorization_code',
  });
}

async function accessToken() {
  if (!cachedToken || cachedToken.expiresAt <= Date.now()) {
    const body = JSON.stringify({
      grant_type: 'client_credential', appid: APP_ID, secret: process.env.WECHAT_APP_SECRET,
    });
    const token = await request('/cgi-bin/stable_token', {}, body);
    if (!token.access_token) throw Error('wechat-token-unavailable');
    cachedToken = { value: token.access_token, expiresAt: Date.now() + (token.expires_in - 120) * 1000 };
  }
  return cachedToken.value;
}

async function xpay(path, order, fields) {
  const body = JSON.stringify({ env: order.env, order_id: order._id, ...fields });
  const pay_sig = hmac(appKey(order.env), path + '&' + body);
  try {
    return await request(path, { access_token: await accessToken(), pay_sig }, body);
  } catch (error) {
    if (![40001, 40014, 42001].includes(error.wechatCode)) throw error;
    cachedToken = null;
    return request(path, { access_token: await accessToken(), pay_sig }, body);
  }
}

module.exports = { APP_ID, appKey, session, xpay };
