const test = require('node:test');
const assert = require('node:assert/strict');
const { signPurchase, isPaid, deliver, TERM } = require('../cloudfunctions/membership/payment');

const order = { _id: 'v12345678', openid: 'buyer', env: 1, productId: '74587613', price: 990 };
const paid = { order_id: order._id, wx_order_id: 'wx-1', status: 2, paid_fee: 990, order_type: 0 };

test('signs the exact fixed-price purchase payload for the selected environment', () => {
  const result = signPurchase(order, 'test-app-key', 'test-session-key');
  const hmac = (key, body) => require('crypto').createHmac('sha256', key).update(body).digest('hex');
  assert.equal(result.mode, 'short_series_goods');
  // attach 是官方 signData 的必填透传字段，发货推送会原样返回。
  assert.deepEqual(JSON.parse(result.signData), {
    offerId: '1450698745', buyQuantity: 1, env: 1, currencyType: 'CNY',
    productId: '74587613', goodsPrice: 990, outTradeNo: order._id, attach: 'membership-30d',
  });
  assert.equal(result.paySig, hmac('test-app-key', 'requestVirtualPayment&' + result.signData));
  assert.equal(result.signature, hmac('test-session-key', result.signData));
});

test('virtual payment failures surface the documented reason and keep uncertain orders', async () => {
  const client = require('../utils/membership-client');
  const storage = new Map();
  let fail;
  let createResult = null;
  const wx = {
    login: ({ success }) => success({ code: 'login-code' }),
    getDeviceInfo: () => ({ platform: 'ios' }),
    cloud: { callFunction: async ({ data }) => {
      if (data.action === 'create') return { result: createResult || { ok: true, orderId: order._id, payData: {} } };
      return { result: { ok: true } };
    } },
    setStorageSync: (key, value) => storage.set(key, value),
    getStorageSync: key => storage.get(key),
    removeStorageSync: key => storage.delete(key),
    requestVirtualPayment: ({ fail: reject }) => reject(fail),
  };

  // iOS 在沙箱环境无法使用 Apple 支付，服务端直接拒绝并给出原因。
  createResult = { ok: false, err: 'payment-ios-sandbox' };
  await assert.rejects(client.purchase(wx), /iOS 端暂不支持测试环境支付/);
  assert.equal(client.pendingOrder(wx), '');
  createResult = null;

  // 明确的失败码：给出可执行提示并放弃本次订单，避免重复占用。
  fail = { errCode: -15011 };
  await assert.rejects(client.purchase(wx), { message: '当前为测试环境，暂不支持 iOS 支付' });
  assert.equal(client.pendingOrder(wx), '');

  // 结果未知的失败：保留订单等待核对，不能当作用户放弃。
  fail = { errCode: -1 };
  await assert.rejects(client.purchase(wx), { message: '支付未完成，请稍后查询订单确认结果' });
  assert.equal(client.pendingOrder(wx), order._id);
  storage.clear();

  // 未收录的失败码保留原始错误，便于日志定位。
  fail = { errCode: -99999, errMsg: 'unknown failure' };
  await assert.rejects(client.purchase(wx), { errMsg: 'unknown failure' });
});

test('outTradeNo stays inside the documented 8-32 character alphabet', () => {
  const { randomBytes } = require('crypto');
  for (let i = 0; i < 50; i++) {
    const id = 'v' + randomBytes(15).toString('hex');
    assert.match(id, /^[0-9a-zA-Z_\-|*@]{8,32}$/);
    assert.equal(id.startsWith('_'), false);
  }
});

test('only accepts matching paid purchase orders', () => {
  assert.equal(isPaid(order, paid), true);
  for (const patch of [{ paid_fee: 1 }, { status: 1 }, { status: 5 }, { order_type: 8 }, { order_id: 'other' }, { wx_order_id: '' }]) {
    assert.equal(isPaid(order, { ...paid, ...patch }), false);
  }
});

test('transaction grants once and extends a current membership', async () => {
  const orders = { [order._id]: { ...order } };
  const rights = { buyer: { tier: 'vip', expiresAt: 2000 } };
  const tables = { membershipOrders: orders, entitlements: rights, membershipReceipts: {} };
  const db = { runTransaction: fn => fn({ collection: name => ({
    doc: id => ({
      get: async () => ({ data: tables[name][id] }),
      set: async ({ data }) => { tables[name][id] = data; },
      update: async ({ data }) => { Object.assign(tables[name][id], data); },
    }),
  }) }) };
  await assert.rejects(deliver(db, { ...order, openid: 'other' }, paid, 1000));
  assert.equal(rights.buyer.expiresAt, 2000);
  assert.equal(await deliver(db, order, paid, 1000), 2000 + TERM);
  assert.equal(await deliver(db, order, paid, 1001), 2000 + TERM);
  assert.equal(rights.buyer.expiresAt, 2000 + TERM);
  const second = { ...order, _id: 'v12345679' };
  orders[second._id] = second;
  await assert.rejects(deliver(db, second, { ...paid, order_id: second._id }, 1002));
  assert.equal(await deliver(db, second, { ...paid, order_id: second._id, wx_order_id: 'wx-2' }, 1002), 2000 + 2 * TERM);
});

test('an expired member can import updates to existing items but cannot add a new one', () => {
  const { apply } = require('../cloudfunctions/portfolio/workspace');
  const items = Array.from({ length: 6 }, (_, i) => 'asset-' + i);
  const doc = { items, groups: [], annotations: {}, revision: 1 };
  const input = {
    action: 'batchAdd', revision: 1, assetIds: [items[0]], groupSettings: [],
    entries: [{ assetId: items[0], note: '保留的标的', tags: [], groups: [] }],
  };
  assert.equal(apply(doc, input, { watchlist: 5 }, 1000), true);
  assert.throws(() => apply(doc, { ...input, assetIds: ['asset-new'] }, { watchlist: 5 }, 1000),
    { businessCode: 'watchlist-limit' });
});

test('checkout cancellation clears local state and success waits for server confirmation', async () => {
  const client = require('../utils/membership-client');
  const storage = new Map();
  let cancel = true;
  let status = 'pending';
  const wx = {
    login: ({ success }) => success({ code: 'login-code' }),
    cloud: { callFunction: async ({ data }) => ({ result: data.action === 'create'
      ? { ok: true, orderId: order._id, payData: { mode: 'short_series_goods' } }
      : { ok: true, status } }) },
    setStorageSync: (key, value) => storage.set(key, value),
    getStorageSync: key => storage.get(key),
    removeStorageSync: key => storage.delete(key),
    requestVirtualPayment: ({ success, fail }) => cancel ? fail({ errCode: -2 }) : success(),
  };
  assert.equal(await client.purchase(wx), false);
  assert.equal(client.pendingOrder(wx), '');
  cancel = false;
  assert.equal(await client.purchase(wx), true);
  assert.equal((await client.confirm(wx)).status, 'pending');
  assert.equal(client.pendingOrder(wx), order._id);
  status = 'delivered';
  assert.equal((await client.confirm(wx)).status, 'delivered');
  assert.equal(client.pendingOrder(wx), '');
});

test('polls an existing order through pending and transient failures without creating a new order', async () => {
  const { confirmUntilSettled } = require('../utils/membership-client');
  const responses = [{ ok: true, status: 'pending' }, { ok: false, err: 'payment-unavailable' }, { ok: true, status: 'delivered' }];
  const calls = [];
  const wx = {
    cloud: { callFunction: async ({ data }) => {
      calls.push(data);
      return { result: responses.shift() };
    } },
    getStorageSync: () => ({ orderId: order._id, createdAt: Date.now() }),
    removeStorageSync() {},
  };
  assert.equal((await confirmUntilSettled(wx, { delays: [0, 0, 0] })).status, 'delivered');
  assert.deepEqual(calls, Array.from({ length: 3 }, () => ({ action: 'confirm', orderId: order._id })));
});

test('recovers an existing pending order when local storage is empty', async () => {
  const { recoverOrder, pendingOrder } = require('../utils/membership-client');
  const storage = new Map();
  const wx = {
    cloud: { callFunction: async ({ data }) => {
      assert.equal(data.action, 'recover');
      return { result: { ok: true, orderId: order._id, createdAt: Date.now() } };
    } },
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
  };
  assert.equal(await recoverOrder(wx), order._id);
  assert.equal(pendingOrder(wx), order._id);
});

test('ad reward requires an account ticket and grants one non-stacking day', async () => {
  const { reward, REWARD_TERM } = require('../cloudfunctions/membership/reward');
  const accounts = {};
  const db = { runTransaction: fn => fn({ collection: () => ({ doc: id => ({
    get: async () => ({ data: accounts[id] && { ...accounts[id] } }),
    set: async ({ data }) => { accounts[id] = data; },
    update: async ({ data }) => Object.assign(accounts[id], data),
  }) }) }) };
  const now = 100000;
  const { ticket } = await reward(db, 'buyer', 'start', null, now);
  assert.equal((await reward(db, 'other', 'claim', ticket, now + 1000)).err, 'reward-ticket-invalid');
  const granted = await reward(db, 'buyer', 'claim', ticket, now + 1000);
  assert.equal(granted.expiresAt, now + 1000 + REWARD_TERM);
  assert.deepEqual(await reward(db, 'buyer', 'claim', ticket, now + 2000), granted);
  assert.equal((await reward(db, 'buyer', 'start', null, now + 2000)).err, 'membership-active');
});
