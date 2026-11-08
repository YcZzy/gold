const cloud = require('wx-server-sdk');
const { randomBytes } = require('crypto');
const { signPurchase, read, isPaid, deliver, PRODUCT_ID, PRICE, ATTACH } = require('./payment');
const wechat = require('./wechat');
const { reward } = require('./reward');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const orders = db.collection('membershipOrders');
const CHECK_INTERVAL = 5 * 60000;
const DAY = 86400000;
const SWEEP_WINDOW = 7 * DAY;
const ORDER_ID = /^v[a-f0-9]{30}$/;

async function reconcile(order, acknowledge = true) {
  if (order.deliveredAt && (!acknowledge || order.acknowledged)) {
    return { status: 'delivered', expiresAt: order.expiresAt };
  }
  const doc = orders.doc(order._id);
  if (order.closed) return { status: 'closed' };
  const { order: remote } = await wechat.xpay('/xpay/query_order', order, { openid: order.openid });
  if (isPaid(order, remote)) {
    const expiresAt = await deliver(db, order, remote, Date.now());
    if (acknowledge) {
      if (remote.status === 2) await wechat.xpay('/xpay/notify_provide_goods', order);
      if (remote.status !== 3) {
        await doc.update({ data: { acknowledged: true, nextCheckAt: null } });
      }
    }
    return { status: 'delivered', expiresAt };
  }
  if (remote && remote.order_id === order._id && [5, 6, 8].includes(remote.status)) {
    await doc.update({ data: { closed: true, nextCheckAt: null } });
    return { status: 'closed' };
  }
  return { status: 'pending' };
}

async function sweep() {
  const now = Date.now();
  const { data } = await orders.where({
    nextCheckAt: db.command.gt(0).and(db.command.lte(now)),
  }).orderBy('nextCheckAt', 'asc').limit(20).get();
  const outcomes = await Promise.allSettled(data.map(async order => {
    const age = now - order.createdAt;
    const nextCheckAt = age >= SWEEP_WINDOW ? null : now + (age < DAY ? CHECK_INTERVAL : DAY);
    const result = await orders.where({ _id: order._id, nextCheckAt: order.nextCheckAt })
      .update({ data: { nextCheckAt } });
    if (result.stats.updated) await reconcile(order);
  }));
  return { ok: true, checked: data.length, failed: outcomes.filter(result => result.status === 'rejected').length };
}

exports.main = async (event = {}) => {
  const context = cloud.getWXContext();
  const notification = event.Event === 'xpay_goods_deliver_notify' && !context.OPENID;
  try {
    if (notification) {
      if (!ORDER_ID.test(event.OutTradeNo || '')) throw Error('invalid-order');
      const order = await read(orders.doc(event.OutTradeNo));
      const goods = event.GoodsInfo;
      if (!order || order.openid !== event.OpenId || (event.Env != null && event.Env !== order.env) ||
          !goods || goods.ProductId !== order.productId || goods.Quantity !== 1) throw Error('notification-mismatch');
      // Confirm with WeChat even for a platform-routed notification.
      const result = await reconcile(order, false);
      if (result.status !== 'delivered') throw Error('payment-unconfirmed');
      // The notification response acknowledges delivery. The timer verifies platform status.
      return { ErrCode: 0, ErrMsg: 'success' };
    }

    if (!context.OPENID && event.Type === 'Timer' && event.TriggerName === 'reconcileMembership') return await sweep();
    if (!context.OPENID || context.APPID !== wechat.APP_ID) return { ok: false, err: 'unauthorized' };

    if (event.action === 'startAdReward') return await reward(db, context.OPENID, 'start', null, Date.now());
    if (event.action === 'claimAdReward') {
      if (typeof event.ticket !== 'string' || !/^[a-f0-9]{32}$/.test(event.ticket)) {
        return { ok: false, err: 'reward-ticket-invalid' };
      }
      return await reward(db, context.OPENID, 'claim', event.ticket, Date.now());
    }

    if (event.action === 'create') {
      const configuredEnv = process.env.XPAY_ENV;
      const env = Number(configuredEnv);
      if (!['0', '1'].includes(configuredEnv) || !process.env.WECHAT_APP_SECRET) throw Error('payment-not-configured');
      // Apple 支付不支持沙箱环境，iOS 在 env=1 下无法下单，直接给出可识别的原因。
      if (env === 1 && event.platform === 'ios') return { ok: false, err: 'payment-ios-sandbox' };
      const key = wechat.appKey(env);
      if (typeof event.code !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(event.code)) throw Error('invalid-login-code');
      const session = await wechat.session(event.code);
      if (session.openid !== context.OPENID || !session.session_key) return { ok: false, err: 'unauthorized' };
      const createdAt = Date.now();
      const order = {
        _id: 'v' + randomBytes(15).toString('hex'), openid: context.OPENID,
        env, productId: PRODUCT_ID, price: PRICE, attach: ATTACH, createdAt, nextCheckAt: createdAt + CHECK_INTERVAL,
      };
      await orders.add({ data: order });
      return { ok: true, orderId: order._id, payData: signPurchase(order, key, session.session_key) };
    }

    if (event.action === 'recover') {
      const { data } = await orders.where({
        openid: context.OPENID,
        createdAt: db.command.gt(Date.now() - DAY),
      }).orderBy('createdAt', 'desc').limit(1).get();
      const latest = data[0];
      if (!latest || latest.deliveredAt || latest.closed || latest.checkoutDismissed) return { ok: true };
      return { ok: true, orderId: latest._id, createdAt: latest.createdAt };
    }

    if (event.action === 'dismiss' && ORDER_ID.test(event.orderId || '')) {
      const order = await read(orders.doc(event.orderId));
      if (!order || order.openid !== context.OPENID) return { ok: false, err: 'order-not-found' };
      await orders.doc(order._id).update({ data: { checkoutDismissed: true } });
      return { ok: true };
    }

    if (event.action === 'confirm' && ORDER_ID.test(event.orderId || '')) {
      const order = await read(orders.doc(event.orderId));
      if (!order || order.openid !== context.OPENID) return { ok: false, err: 'order-not-found' };
      // The timer handles the platform acknowledgment independently of the UI.
      return { ok: true, ...await reconcile(order, false) };
    }
    return { ok: false, err: 'unknown-action' };
  } catch (error) {
    if (error.wechatCode) console.warn('membership WeChat API code', error.wechatCode);
    if (notification) return { ErrCode: 1, ErrMsg: 'delivery-unconfirmed' };
    return { ok: false, err: error.message === 'payment-not-configured' ? 'payment-not-configured' : 'payment-unavailable' };
  }
};
