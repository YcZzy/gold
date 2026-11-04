const test = require('node:test');
const assert = require('node:assert/strict');
const { signPurchase, isPaid, deliver, TERM } = require('../cloudfunctions/membership/payment');

const order = { _id: 'v12345678', openid: 'buyer', env: 1, productId: '74587613', price: 990 };
const paid = { order_id: order._id, wx_order_id: 'wx-1', status: 2, paid_fee: 990, order_type: 0 };

test('signs the exact fixed-price purchase payload for the selected environment', () => {
  const result = signPurchase(order, 'test-app-key', 'test-session-key');
  const hmac = (key, body) => require('crypto').createHmac('sha256', key).update(body).digest('hex');
  assert.equal(result.mode, 'short_series_goods');
  assert.deepEqual(JSON.parse(result.signData), {
    offerId: '1450698745', buyQuantity: 1, env: 1, currencyType: 'CNY',
    productId: '74587613', goodsPrice: 990, outTradeNo: order._id,
  });
  assert.equal(result.paySig, hmac('test-app-key', 'requestVirtualPayment&' + result.signData));
  assert.equal(result.signature, hmac('test-session-key', result.signData));
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
