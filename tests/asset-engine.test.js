const { test } = require("node:test");
const assert = require("node:assert/strict");
const { memoryDb } = require("./helpers/asset-db");
const { createAssetTasks, planRuleTask, buildMessage } = require("../cloudfunctions/sendTask/asset-tasks");
const { templates } = require("../utils/app-config");
const now = Date.parse("2026-10-27T09:02:00+08:00");
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
  const scheduled = planRuleTask({ ...rule, type: "scheduled", time: "09:00" }, asset, quote, [], now, "u");
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
