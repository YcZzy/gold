const test = require('node:test');
const assert = require('node:assert/strict');
const { createCache } = require('../utils/read-cache');
function platform() {
  const values = new Map();
  return { getStorageSync: k => values.get(k), setStorageSync: (k, v) => values.set(k, JSON.parse(JSON.stringify(v))) };
}
test('successful reads survive a new client and failed refresh without changing timestamps', async () => {
  const wx = platform();
  const a = createCache(wx);
  await a.fetch('quote:a', async () => ({ price: 100, sourceTime: 123 }));
  const b = createCache(wx);
  assert.deepEqual(await b.fetch('quote:a', async () => { throw Error('offline'); }), { price: 100, sourceTime: 123 });
});
test('cache separates assets, periods and search terms and never invents missing data', async () => {
  const c = createCache(platform());
  c.write('chart:a:1mo', { points: [1] });
  for (const key of ['chart:a:1y', 'chart:b:1mo', 'search:b'])
    await assert.rejects(c.fetch(key, async () => { throw Error('offline'); }), /offline/);
});
test('invalid empty responses cannot overwrite the last usable result', async () => {
  const c = createCache(platform());
  c.write('quote:a', { price: 100 });
  assert.deepEqual(await c.fetch('quote:a', async () => ({ price: null }), x => x.price != null), { price: 100 });
  assert.deepEqual(c.read('quote:a'), { price: 100 });
});
test('storage failures still allow memory fallback and caller mutations do not corrupt it', async () => {
  const c = createCache({ getStorageSync() { throw Error(); }, setStorageSync() { throw Error(); } });
  const value = await c.fetch('x', async () => ({ rows: [1] }));
  value.rows.length = 0;
  assert.deepEqual(c.read('x'), { rows: [1] });
});
test('status fallback preserves quotas and successful writes update the fallback', async () => {
  const status = require('../utils/status-client');
  const wx = platform();
  let fail = false;
  wx.cloud = { callFunction: async () => { if (fail) throw Error('offline'); return { result: { ok: true, remaining: { brief: 3 }, prefs: { dndStart: '22:00' }, recentTasks: [{ taskId: '1' }] } }; } };
  await status.getStatus(wx);
  status.updateStatus(wx, { ok: true, remaining: { brief: 4 } });
  fail = true;
  const result = await status.getStatus(wx);
  assert.equal(result.remaining.brief, 4);
  assert.equal(result.prefs.dndStart, '22:00');
  assert.equal(result.recentTasks[0].taskId, '1');
});
test('market reads retain per-asset quotes and per-period charts without mixing statistics', async () => {
  const market = require('../utils/market-client');
  const previous = global.wx;
  const wx = platform();
  let mode = 'good';
  wx.cloud = { callFunction: async ({ data }) => {
    if (mode === 'fail') throw Error('offline');
    if (data.action === 'chart') return { result: { ok: true, chart: { candles: [{ time: '2026-10-26', c: 100 }], sourceTime: 123 } } };
    if (data.action === 'quotes') return { result: { ok: true, quotes: [{ assetId: 'sh600519', price: 102, open: null }] } };
    return { result: { ok: true, asset: { id: data.assetId }, quote: { assetId: data.assetId, price: 100, open: 99, sourceTime: 123 } } };
  } };
  global.wx = wx;
  try {
    await market.quote('sh600519');
    await market.chart('sh600519', '1mo');
    assert.equal((await market.quotes(['sh600519'])).quotes[0].open, null);
    mode = 'fail';
    assert.equal((await market.quote('sh600519')).quote.price, 102);
    assert.equal((await market.chart('sh600519', '1mo')).chart.sourceTime, 123);
    await assert.rejects(market.chart('sh600519', '1y'));
    await assert.rejects(market.quote('sz000001'));
  } finally { global.wx = previous; }
});

test('market outage labels quote and chart fallbacks without changing provider time', async () => {
  const market = require('../utils/market-client');
  const previous = global.wx;
  const wx = platform();
  let fail = false;
  const timestamp = Date.now();
  wx.cloud = { callFunction: async ({data}) => {
    if (fail) throw Error('offline');
    return {result: data.action === 'chart'
      ? {ok:true, chart:{points:[{time:'10:00',price:100}],sourceTime:timestamp,stale:false}}
      : {ok:true,quote:{assetId:'sh600519',price:100,sourceTime:timestamp,status:'fresh',stale:false}}};
  }};
  global.wx = wx;
  try {
    await market.quote('sh600519');
    await market.chart('sh600519');
    fail = true;
    const q = (await market.quote('sh600519')).quote;
    assert.equal(q.stale, true);
    assert.equal(q.status, 'delayed');
    assert.equal(q.sourceTime, timestamp);
    assert.equal((await market.quotes(['sh600519'])).quotes[0].stale, true);
    assert.equal((await market.chart('sh600519')).chart.stale, true);
  } finally { global.wx = previous; }
});

test('partial quote failures mark only the missing asset as cached', async () => {
  const market = require('../utils/market-client');
  const previous = global.wx;
  const wx = platform();
  const now = Date.now();
  let partial = false;
  wx.cloud = {callFunction:async()=>({result:{ok:true,quotes:partial
    ? [{assetId:'sh600519',price:101,sourceTime:now,status:'fresh',stale:false}]
    : ['sh600519','sz000001'].map(assetId=>({assetId,price:100,sourceTime:now,status:'fresh',stale:false}))}})};
  global.wx = wx;
  try {
    await market.quotes(['sh600519','sz000001']); partial = true;
    const r = await market.quotes(['sh600519','sz000001']);
    assert.equal(r.quotes[0].stale, false);
    assert.equal(r.quotes[1].stale, true);
  } finally { global.wx = previous; }
});
