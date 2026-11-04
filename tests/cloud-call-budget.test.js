const {test} = require('node:test');
const assert = require('node:assert/strict');
const {install} = require('../utils/cloud-call-budget');

function setup({saved, storageFails = false} = {}) {
  let time = Date.parse('2026-11-03T00:00Z');
  let failure;
  const calls = [];
  const platform = {
    getStorageSync() { if (storageFails) throw Error('storage unavailable'); return saved; },
    setStorageSync() { if (storageFails) throw Error('storage unavailable'); },
    cloud: {callFunction: async options => {
      calls.push(options);
      if (options.name === 'callBudget') throw Error('retired budget service');
      if (failure) throw failure;
      return {result: {ok: true, chart: {points: [1, 2]}, invocationCost: 1}};
    }}
  };
  install(platform, () => time);
  return {platform, calls, advance(ms) { time += ms; }, fail(error) { failure = error; }};
}

test('exhausted legacy balances do not block reads, writes or imports', async () => {
  const f = setup({saved: {month: '2026-11', used: 800, credits: 0, exhausted: true}});
  for (const request of [
    {name: 'portfolio', data: {action: 'list'}},
    {name: 'portfolio', data: {action: 'add'}},
    {name: 'ledger', data: {action: 'import'}},
    {name: 'savePrefs'}
  ]) assert.equal((await f.platform.cloud.callFunction(request)).result.ok, true);
  assert.deepEqual(f.calls.map(call => call.name), ['portfolio', 'portfolio', 'ledger', 'savePrefs']);
});

test('more than 200 concurrent operations succeed without leasing credits', async () => {
  const f = setup();
  const results = await Promise.all(Array.from({length: 250}, () => f.platform.cloud.callFunction({name: 'savePrefs'})));
  assert.equal(results.length, 250);
  assert.equal(f.calls.length, 250);
});

test('unavailable device storage does not prevent cloud operations', async () => {
  const f = setup({storageFails: true});
  assert.equal((await f.platform.cloud.callFunction({name: 'portfolio'})).result.ok, true);
  assert.equal(f.calls.length, 1);
});

test('successful chart requests share in-flight work and reuse isolated cached data until expiry', async () => {
  const f = setup();
  const request = {name: 'marketData', data: {action: 'chart', assetId: 'sh600519', period: '1y'}};
  const [first, second] = await Promise.all([f.platform.cloud.callFunction(request), f.platform.cloud.callFunction(request)]);
  first.result.chart.points.push(3);
  assert.deepEqual(second.result.chart.points, [1, 2]);
  const cached = await f.platform.cloud.callFunction(request);
  assert.equal(cached.result.chart.cached, true);
  assert.deepEqual(cached.result.chart.points, [1, 2]);
  assert.equal(f.calls.length, 1);
  f.advance(900001);
  await f.platform.cloud.callFunction(request);
  assert.equal(f.calls.length, 2);
});

test('business failures reach fail and complete callbacks without blocking subsequent retries', async () => {
  const f = setup();
  const error = Error('network timeout');
  const seen = [];
  f.fail(error);
  const request = {name: 'marketData', data: {action: 'search', query: '黄金'}};
  await assert.rejects(f.platform.cloud.callFunction({...request, fail: e => seen.push(e), complete: e => seen.push(e)}), /network timeout/);
  assert.deepEqual(seen, [error, error]);
  f.fail(null);
  const success = [];
  const result = await f.platform.cloud.callFunction({...request, success: value => success.push(value), complete: value => success.push(value)});
  assert.deepEqual(success, [result, result]);
  assert.equal(f.calls.length, 2);
});

test('installing the wrapper twice does not duplicate business requests', async () => {
  const f = setup();
  install(f.platform);
  await f.platform.cloud.callFunction({name: 'savePrefs'});
  assert.equal(f.calls.length, 1);
});
