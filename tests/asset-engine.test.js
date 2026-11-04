const { test } = require("node:test");
const assert = require("node:assert/strict");
const { memoryDb } = require("./helpers/asset-db");
const { createAssetTasks, planRuleTask, buildMessage } = require("../cloudfunctions/sendTask/asset-tasks");
const { templates } = require("../utils/app-config");
// Price/volatility monitoring now requires an actual regular trading session.
const now = Date.parse("2026-10-27T10:02:00+08:00");
const asset = { id: "sh600519", name: "贵州茅台", code: "600519", kind: "stock", market: "SH", currency: "CNY", unit: "元/股", precision: 2 };
const quote = { assetId: asset.id, price: 900, prevClose: 910, change: -10, changePct: -1.1, sourceTime: now, fetchedAt: now, source: "tencent", stale: false, status: "fresh" };
const rule = { id: "rule-1", assetId: asset.id, type: "priceBelow", value: 900, enabled: true, version: "v1" };
function fixture(options = {}) {
  let time = now;
  const { db, tables } = memoryDb({
    portfolios: [{ _id: "u", openid: "u", migrationVersion: 1, revision: 1, items: [asset.id], rules: [rule] }],
    preferences: [{ _id: "u", openid: "u", multiAssetVersion: 1 }],
    subscriptions: [{ _id: "u:" + templates.volatility, openid: "u", templateId: templates.volatility, remaining: 20 }, { _id: "u:" + templates.dailyBrief, openid: "u", templateId: templates.dailyBrief, remaining: 20 }],
    ...(options.tables || {})
  });
  const sent = [], calls = [];
  const cloud = {
    async callFunction({ name, data }) {
      calls.push({ name, data });
      return { result: { ok: true, assets: [asset], quotes: [{ ...quote, sourceTime: time, fetchedAt: time }], errors: [] } };
    },
    openapi: { subscribeMessage: { async send(data) { if (options.error) throw options.error; sent.push(data); return { errCode: 0 }; } } }
  };
  const engine = createAssetTasks({ db, cloud, templates, now: () => time });
  return { engine, db, tables, sent, calls, advance(ms) { time += ms; } };
}
async function trigger(f) { await f.engine.scan(); const task = f.tables.sendTasks[0]; await f.engine.handleTask(task); return task; }

test("price equality creates a versioned target task with unambiguous stock identity", () => {
  const task = planRuleTask(rule, asset, quote, [], now, "u");
  assert.ok(task);
  assert.equal(task.assetId, asset.id);
  assert.equal(task.ruleVersion, "v1");
  assert.equal(task.priority, 1);
});

test("unknown source time, stale cache, wrong stock and missing quotes do not trigger", () => {
  for (const q of [null, { ...quote, sourceTime: null }, { ...quote, stale: true }, { ...quote, assetId: "sz000001" }, { ...quote, price: 0 }]) assert.equal(planRuleTask(rule, asset, q, [], now, "u"), null);
});

test("rapid moves compare only same-symbol, same-provider continuous observations", () => {
  const r = { ...rule, type: "rapidMove", value: 1 };
  const sample = { at: now - 15 * 60000, ...quote, price: 920, sourceTime: now - 15 * 60000, fetchedAt: now - 15 * 60000 };
  assert.ok(planRuleTask(r, asset, quote, [sample], now, "u"));
  assert.equal(planRuleTask(r, asset, quote, [{ ...sample, source: "other" }], now, "u"), null);
  assert.equal(planRuleTask(r, asset, quote, [{ ...sample, assetId: "sz000001" }], now, "u"), null);
});

test("scheduled midnight uses previous calendar date while close requires today's closed quote", () => {
  const at = Date.parse("2026-10-28T00:00:00+08:00");
  const task = planRuleTask({ ...rule, type: "scheduled", time: "23:59", weekdaysOnly: true }, asset, { ...quote, fetchedAt: at }, [], at, "u");
  assert.ok(task);
  assert.ok(task._id.endsWith("20261027"));
  const closeNow = Date.parse("2026-10-27T15:10:00+08:00");
  assert.equal(planRuleTask({ ...rule, type: "close" }, asset, quote, [], closeNow, "u"), null);
  assert.ok(planRuleTask({ ...rule, type: "close" }, asset, { ...quote, sourceTime: closeNow - 10 * 60000, fetchedAt: closeNow }, [], closeNow, "u"));
});

test("each existing template includes stock name, units and correct data fields", () => {
  const t = planRuleTask(rule, asset, quote, [], now, "u");
  assert.match(buildMessage(t).thing2.value, /贵州茅台/);
  const scheduled = planRuleTask({ ...rule, type: "scheduled", time: "10:00" }, asset, quote, [], now, "u");
  assert.match(buildMessage(scheduled).thing15.value, /贵州茅台/);
  assert.equal(buildMessage(scheduled).amount5.value, "¥900.00");
});

test("scan sends target once, links to stock detail, and consumes the matching version", async () => {
  const f = fixture();
  await trigger(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].templateId, templates.volatility);
  assert.equal(f.sent[0].page, "pages/detail/detail?assetId=sh600519");
  assert.equal(f.tables.portfolios[0].rules[0].enabled, false);
  assert.equal(f.tables.subscriptions[0].remaining, 19);
  await f.engine.scan();
  assert.equal(f.tables.sendTasks.length, 1);
});

test("edited or removed stock rules cancel old tasks without spending quota", async () => {
  const f = fixture();
  await f.engine.scan();
  f.tables.portfolios[0].rules[0].version = "v2";
  await f.engine.handleTask(f.tables.sendTasks[0]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.tables.subscriptions[0].remaining, 20);
  assert.equal(f.tables.sendTasks[0].status, "cancelled");
});

test("concurrent different targets respect one global target budget atomically", async () => {
  const f = fixture();
  f.tables.sendBudgets = [{ _id: "u:20261027", regular: 0, targets: 3, counts: {}, reservations: {} }];
  await f.engine.scan();
  const task = f.tables.sendTasks[0];
  const otherRule = { ...rule, id: "r2", type: "priceAbove", value: 899 };
  f.tables.portfolios[0].rules.push(otherRule);
  const other = planRuleTask(otherRule, asset, quote, [], now, "u");
  f.tables.sendTasks.push({ ...other, status: "processing", retryCount: 0 });
  await Promise.all([f.engine.handleTask(task), f.engine.handleTask(other)]);
  assert.equal(f.sent.length, 1);
  assert.equal(f.tables.sendBudgets[0].targets, 4);
});

test("a transient failure refunds both platform quota and daily budget", async () => {
  const f = fixture({ error: { errCode: -1 } });
  await trigger(f);
  assert.equal(f.tables.sendTasks[0].status, "pending");
  assert.equal(f.tables.sendTasks[0].retryCount, 1);
  assert.equal(f.tables.subscriptions[0].remaining, 20);
  assert.equal(f.tables.sendBudgets[0].targets, 0);
  assert.equal(f.tables.portfolios[0].rules[0].enabled, true);
});

test("unknown send result retains quota/budget and is never requeued", async () => {
  const f = fixture({ error: new Error("disconnected") });
  await trigger(f);
  assert.equal(f.tables.sendTasks[0].status, "pending-check");
  assert.equal(f.tables.subscriptions[0].remaining, 19);
  assert.equal(f.tables.sendBudgets[0].targets, 1);
});

test("migration carries old gold send counts into new daily budget", async () => {
  const gold = { ...asset, id: "gold-au9999", kind: "gold", name: "沪金" };
  const r = { ...rule, assetId: gold.id };
  const f = fixture({ tables: { portfolios: [{ _id: "u", openid: "u", items: [gold.id], rules: [r], migrationVersion: 1 }], sendTasks: [{ _id: "legacy", type: "targetAuLow", openid: "u", status: "sent", sentAt: now - 1000 }] } });
  const task = planRuleTask(r, gold, { ...quote, assetId: gold.id }, [], now, "u");
  f.tables.sendTasks.push({ ...task, status: "processing" });
  await f.engine.handleTask(task);
  assert.equal(f.sent.length, 0);
  assert.equal(f.tables.sendTasks[1].status, "skipped");
});

test("unresolved same-day legacy sends also reserve their category during migration", async () => {
  const gold = { ...asset, id: "gold-au9999", kind: "gold", name: "沪金" };
  const r = { ...rule, assetId: gold.id, type: "dailyMove", value: 1 };
  const f = fixture({ tables: { portfolios: [{ _id: "u", openid: "u", items: [gold.id], rules: [r], migrationVersion: 1 }], sendTasks: [{ _id: "uncertain", type: "volAu", openid: "u", status: "pending-check", updatedAt: now - 1000 }] } });
  const task = planRuleTask(r, gold, { ...quote, assetId: gold.id }, [], now, "u");
  f.tables.sendTasks.push({ ...task, status: "processing" });
  await f.engine.handleTask(task);
  assert.equal(f.sent.length, 0);
  assert.equal(f.tables.sendTasks[1].status, "skipped");
});

test("cloud transaction callback replay starts from a fresh budget seed", async () => {
  const f = fixture();
  const actualTransaction = f.db.runTransaction;
  let replay = true;
  f.db.runTransaction = async callback => {
    if (replay) {
      replay = false;
      // 模拟冲突：第一次回调完成，但其写入被数据库丢弃。
      await memoryDb(f.tables).db.runTransaction(callback);
    }
    return actualTransaction(callback);
  };
  await trigger(f);
  assert.equal(f.sent.length, 1);
  assert.equal(f.tables.sendTasks[0].status, "sent");
  assert.equal(f.tables.subscriptions[0].remaining, 19);
  assert.equal(f.tables.sendBudgets[0].targets, 1);
});

test("deleting all asset rules prevents queued reminders and preserves quota", async () => {
  const f = fixture();
  await f.engine.scan();
  f.tables.portfolios[0].rules = [];
  await f.engine.handleTask(f.tables.sendTasks[0]);
  assert.equal(f.sent.length, 0);
  assert.equal(f.tables.subscriptions[0].remaining, 20);
  assert.equal(f.tables.sendTasks[0].status, "cancelled");
});

test("asset price and percentage alerts are due immediately when detected", () => {
  for (const type of ["priceAbove", "priceBelow", "dailyMove", "rapidMove"]) {
    const r = { ...rule, type, value: type.startsWith("price") ? 900 : 1 };
    const sample = { ...quote, at: now - 15 * 60000, sourceTime: now - 15 * 60000, price: 920 };
    const task = planRuleTask(r, asset, quote, [sample], now, "u");
    assert.ok(task, type);
    assert.equal(task.triggerTime, now, type);
  }
});

test("asset short-move snapshots retain each minute and the 15-minute baseline", async () => {
  const f = fixture({ tables: { portfolios: [{ _id: "u", openid: "u", migrationVersion: 1, items: [asset.id], rules: [{ ...rule, type: "rapidMove", value: 1 }] }] } });
  for (let minute = 0; minute <= 16; minute++) {
    await f.engine.scan();
    if (minute === 0) f.tables.quoteSnapshots[0].samples[0].price = 920;
    if (minute < 16) f.advance(60000);
  }
  assert.equal(f.tables.quoteSnapshots[0].samples.length, 17);
  assert.equal(f.tables.sendTasks.length, 1);
  assert.equal(f.tables.sendTasks[0].type, "rapidMove");
});

test('scan skips zero relevant quota and resumes after replenishment', async () => {
  const f = fixture();
  f.tables.subscriptions[0].remaining = 0;
  await f.engine.scan();
  assert.equal(f.calls.length, 0);
  assert.equal(f.tables.portfolios[0].rules[0].enabled, true);
  f.tables.subscriptions[0].remaining = 1;
  await f.engine.scan();
  assert.equal(f.calls.length, 1);
  assert.equal(f.tables.sendTasks.length, 1);
});

test('price monitoring skips lunch, weekends and closed sessions before requesting quotes', async () => {
  for (const at of ['2026-10-27T12:00:00+08:00', '2026-10-31T10:00:00+08:00', '2026-10-27T23:00:00+08:00']) {
    const f = fixture();
    f.advance(Date.parse(at) - now);
    await f.engine.scan();
    assert.equal(f.calls.length, 0, at);
  }
});

test('scheduled rules only request quotes inside the six-minute due window including midnight', async () => {
  const f = fixture();
  f.tables.portfolios[0].rules = [{ ...rule, type: 'scheduled', time: '23:59', weekdaysOnly: false }];
  await f.engine.scan();
  assert.equal(f.calls.length, 0);
  f.advance(Date.parse('2026-10-28T00:00:00+08:00') - now);
  await f.engine.scan();
  assert.equal(f.calls.length, 1);
  assert.ok(f.tables.sendTasks[0]._id.endsWith('20261027'));
});

test('close reminder skips morning but queries inside its close window', async () => {
  const f = fixture();
  f.tables.portfolios[0].rules = [{ ...rule, type: 'close' }];
  await f.engine.scan();
  assert.equal(f.calls.length, 0);
  f.advance(Date.parse('2026-10-27T15:10:00+08:00') - now);
  await f.engine.scan();
  assert.equal(f.calls.length, 1);
});

test('already exhausted daily budgets do not request quotes', async () => {
  const f = fixture({ tables: { sendBudgets: [{ _id: 'u:20261027', targets: 4, regular: 0 }] } });
  await f.engine.scan();
  assert.equal(f.calls.length, 0);
});

test('HK broadcasts with only brief quota skip quotes; CNY fallback can use volatility quota', async () => {
  const f = fixture();
  f.tables.portfolios[0].rules = [{ ...rule, type: 'scheduled', time: '10:00' }];
  f.tables.instruments = [{ _id: asset.id, asset: { ...asset, currency: 'HKD' } }];
  f.tables.subscriptions[0].remaining = 0;
  await f.engine.scan();
  assert.equal(f.calls.length, 0);
  f.tables.instruments[0].asset.currency = 'CNY';
  f.tables.subscriptions[1].remaining = 0;
  f.tables.subscriptions[0].remaining = 1;
  await f.engine.scan();
  assert.equal(f.calls.length, 1);
  // Actual returned CNY price fits amount template, whose quota is empty.
  assert.equal((f.tables.sendTasks || []).length, 0);
});

async function scaleScan(shared, at = now, { users = 100, authorized = true, warmWatchlists = false } = {}) {
  const assets = Array.from({ length: shared ? 5 : users * 5 }, (_, i) => ({ ...asset, id: 'sh' + String(600000 + i) }));
  const portfolios = Array.from({ length: users }, (_, i) => ({
    _id: 'u' + i, openid: 'u' + i, migrationVersion: 1,
    items: assets.slice(shared ? 0 : i * 5, shared ? 5 : i * 5 + 5).map(a => a.id),
    rules: assets.slice(shared ? 0 : i * 5, shared ? 5 : i * 5 + 5).map((a, j) => ({ ...rule, id: `r${i}-${j}`, assetId: a.id })),
  }));
  const { db } = memoryDb({ portfolios, subscriptions: !authorized ? [] : portfolios.map(p => ({
    _id: p._id + ':' + templates.volatility, openid: p._id, templateId: templates.volatility, remaining: 5,
  })) });
  const calls = [];
  const cloud = { async callFunction(request) {
    calls.push(request);
    return { result: { ok: true, assets: assets.filter(a => request.data.assetIds.includes(a.id)),
      quotes: request.data.assetIds.map(id => ({ ...quote, assetId: id, sourceTime: at, fetchedAt: at })) } };
  } };
  const engine = createAssetTasks({ db, cloud, templates, now: () => at });
  return { result: await engine.scan({warmWatchlists}), calls };
}

test('100 users with five distinct stocks each use one bulk quote call during trading and zero at night', async () => {
  const trading = await scaleScan(false);
  assert.equal(trading.calls.length, 1);
  assert.equal(trading.result.scanStats.quotedAssets, 500);
  assert.ok(trading.calls.every(call => call.data.assetIds.length <= 500));
  const night = await scaleScan(false, Date.parse('2026-10-27T23:00:00+08:00'));
  assert.equal(night.calls.length, 0);
});

test('100 users watching the same five stocks share one quote batch per scan', async () => {
  const { calls, result } = await scaleScan(true);
  assert.equal(calls.length, 1);
  assert.equal(result.scanStats.quotedAssets, 5);
  assert.equal(result.scanStats.eligible, 500);
});

test('500 users each watching five distinct stocks scan all 2500 stocks with one cloud invocation', async () => {
  const {calls, result} = await scaleScan(false, now, {users:500});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.assetIds.length, 2500);
  assert.equal(new Set(calls[0].data.assetIds).size, 2500);
  assert.equal(result.scanStats.eligible, 2500);
  assert.equal(result.scanStats.quotedAssets, 2500);
  assert.equal(result.scanStats.marketCalls, 1);
  assert.equal(result.created, 2500, 'last-page users must receive their matching tasks too');
  const night = await scaleScan(false, Date.parse('2026-10-27T23:00:00+08:00'), {users:500, warmWatchlists:true});
  assert.equal(night.calls.length, 0);
});

test('500 users sharing five stocks still need only one deduplicated quote request', async () => {
  const {calls, result} = await scaleScan(true, now, {users:500});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].data.assetIds.length, 5);
  assert.equal(result.scanStats.eligible, 2500);
});

test('2500 watched stocks without notification authorization never request quotes', async () => {
  const {calls, result} = await scaleScan(false, now, {users:500, authorized:false, warmWatchlists:true});
  assert.equal(calls.length, 0);
  assert.equal(result.scanStats.quotedAssets, 0);
  assert.equal(result.scanStats.eligible, 0);
  assert.equal(result.created, 0);
});

test('scan rejects capacity overflow explicitly before requesting quotes instead of dropping users', async () => {
  const f = fixture();
  f.tables.portfolios[0].items = Array.from({length:2501}, (_, i) => 'sh' + (600000+i));
  f.tables.portfolios[0].rules = f.tables.portfolios[0].items.map((assetId, i) => ({...rule, id: "r" + i, assetId}));
  await assert.rejects(f.engine.scan({warmWatchlists:true}), /超过2500/);
  assert.equal(f.calls.length, 0);
});

test('known instrument currency and exchange calendars preserve HK and US regular-session scans', async () => {
  for (const [id, market, currency, at, expected] of [
    ['hk00700', 'HK', 'HKD', '2026-10-27T12:30:00+08:00', 0],
    ['hk00700', 'HK', 'HKD', '2026-10-27T14:00:00+08:00', 1],
    ['usAAPL', 'US', 'USD', '2026-10-27T10:00:00+08:00', 0],
    ['usAAPL', 'US', 'USD', '2026-10-27T22:00:00+08:00', 1],
    ['usAAPL', 'US', 'USD', '2026-11-03T22:00:00+08:00', 0],
    ['usAAPL', 'US', 'USD', '2026-11-03T23:00:00+08:00', 1],
  ]) {
    const f = fixture();
    f.tables.portfolios[0].items = [id];
    f.tables.portfolios[0].rules = [{ ...rule, assetId: id }];
    f.tables.instruments = [{ _id: id, asset: { ...asset, id, market, currency } }];
    f.advance(Date.parse(at) - now);
    await f.engine.scan();
    assert.equal(f.calls.length, expected, id + ' ' + at);
  }
});

test('default gold and stock watchlists without enabled reminders never request quotes', async () => {
  const f = fixture();
  f.tables.portfolios[0].items.push('gold-au9999', 'gold-xauusd');
  f.tables.portfolios[0].rules = [];
  const result = await f.engine.scan({warmWatchlists: true});
  assert.equal(f.calls.length, 0);
  assert.equal(result.created, 0);
});

test('mixed watchlists request only enabled and authorized reminder targets', async () => {
  const f = fixture();
  f.tables.portfolios[0].items.push('gold-au9999', 'gold-xauusd', 'sz000001');
  f.tables.portfolios[0].rules.push({...rule, id:'off', assetId:'gold-au9999', enabled:false});
  await f.engine.scan({warmWatchlists:true});
  assert.equal(f.calls.length, 1);
  assert.deepEqual(f.calls[0].data.assetIds, [asset.id]);
});

test('gold reminders need authorization and stop querying after being disabled or removed', async () => {
  const f = fixture();
  const p = f.tables.portfolios[0];
  p.items = ['gold-au9999', 'gold-xauusd'];
  p.rules = [{...rule, assetId:'gold-xauusd'}];
  f.tables.subscriptions[0].remaining = 0;
  await f.engine.scan({warmWatchlists:true});
  assert.equal(f.calls.length, 0);
  f.tables.subscriptions[0].remaining = 1;
  await f.engine.scan({warmWatchlists:true});
  assert.deepEqual(f.calls[0].data.assetIds, ['gold-xauusd']);
  p.rules[0].enabled = false;
  await f.engine.scan({warmWatchlists:true});
  p.rules[0].enabled = true;
  p.items = ['gold-au9999'];
  await f.engine.scan({warmWatchlists:true});
  assert.equal(f.calls.length, 1);
});

test('gold scans skip closed sessions before calling the quote service and resume at open', async () => {
  for (const [id,closed,open] of [
    ['gold-au9999','2026-11-03T19:59+08:00','2026-11-03T20:00+08:00'],
    ['gold-xauusd','2026-11-03T07:04+08:00','2026-11-03T07:05+08:00']
  ]) {
    const f = fixture();
    f.tables.portfolios[0].items = [id];
    f.tables.portfolios[0].rules = [{...rule,assetId:id}];
    f.advance(Date.parse(closed)-now);
    await f.engine.scan();
    assert.equal(f.calls.length,0,id+' closed');
    f.advance(Date.parse(open)-Date.parse(closed));
    await f.engine.scan();
    assert.equal(f.calls.length,1,id+' open');
    assert.deepEqual(f.calls[0].data.assetIds,[id]);
  }
});
