const assert = require("node:assert/strict");
const { test } = require("node:test");
const { loadEngine } = require("./helpers/cloud-harness");
const { templates } = require("../utils/app-config");
const prefs = { _id: "u", openid: "u", dailyBrief: false, targetAuLow: true, targetAuLowPrice: 900, targetAuLowRuleId: "r1" };
const subs = [
  { _id: "v", openid: "u", templateId: templates.volatility, remaining: 20 },
  { _id: "b", openid: "u", templateId: templates.dailyBrief, remaining: 20 }
];
function engine(extra = {}) { return loadEngine({ tables: { preferences: [prefs], subscriptions: subs }, ...extra }); }
async function scanAndDispatch(e) {
  await e.main({ TriggerName: "scanTimer" });
  e.advance(60000);
  await e.main({ TriggerName: "dispatchTimer" });
}

test("scan->dispatch sends one target with existing volatility template and consumes its rule", async () => {
  const e = engine();
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].templateId, templates.volatility);
  assert.equal(e.sent[0].data.thing2.value, "沪金跌到价提醒");
  assert.equal(e.tables.preferences[0].targetAuLow, false);
  assert.equal(e.tables.subscriptions[0].remaining, 19);
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
});

test("overlapping dispatchers cannot both send the same target", async () => {
  const e = engine();
  await e.main({ TriggerName: "scanTimer" });
  e.advance(60000);
  await Promise.all([e.main({ TriggerName: "dispatchTimer" }), e.main({ TriggerName: "dispatchTimer" })]);
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.subscriptions[0].remaining, 19);
});

test("changing rule version before dispatch cancels old target", async () => {
  const e = engine();
  await e.main({ TriggerName: "scanTimer" });
  e.tables.preferences[0].targetAuLowRuleId = "r2";
  e.advance(60000);
  await e.main({});
  assert.equal(e.sent.length, 0);
  assert.equal(e.tables.sendTasks[0].status, "cancelled");
});

test("missing quota keeps a target enabled and allows recovery after quota is replenished", async () => {
  const e = engine({ tables: { preferences: [prefs], subscriptions: [] } });
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 0);
  assert.equal(e.tables.preferences[0].targetAuLow, true);
  e.tables.subscriptions.push(...structuredClone(subs));
  e.advance(5 * 60000);
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
});

test("scheduled broadcast uses existing brief template and does not duplicate on repeat scans", async () => {
  const e = engine({ tables: { preferences: [{ ...prefs, targetAuLow: false, scheduledBrief: true, scheduledTime: "09:01", scheduledWeekdaysOnly: true }], subscriptions: subs } });
  await scanAndDispatch(e);
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
  assert.equal(e.sent[0].templateId, templates.dailyBrief);
  assert.equal(e.tables.sendTasks[0].type, "scheduledBrief");
});

test("short alerts warm up then compare an actual 15 minute snapshot", async () => {
  const e = engine({ tables: { preferences: [{ ...prefs, targetAuLow: false, shortAu: true, shortPct: 1 }], subscriptions: subs } });
  await e.main({ TriggerName: "scanTimer" });
  assert.equal(e.tables.sendTasks.length, 0);
  e.tables.quoteSnapshots[0].samples[0].au.price = 920;
  e.advance(15 * 60000);
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.sendTasks[0].type, "shortAu");
  assert.ok(e.sent[0].data.thing10.value.includes("15分钟"));
});

test("expired DND short alerts never deliver stale next-day warnings", async () => {
  const at = Date.parse("2026-10-27T09:00:00+08:00");
  const e = engine({ tables: {
    preferences: [{ ...prefs, targetAuLow: false, shortAu: true, dndStart: "08:00", dndEnd: "10:00" }], subscriptions: subs,
    sendTasks: [{ _id: "s", openid: "u", type: "shortAu", status: "pending", triggerTime: at, expireAt: at + 60000, meta: { threshold: 1 } }]
  } });
  await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.tables.sendTasks[0].status, "expired");
  assert.equal(e.sent.length, 0);
});

test("a transient send error refunds quota and retries the same task safely", async () => {
  const e = engine({ sendError: { errCode: -1 } });
  await scanAndDispatch(e);
  assert.equal(e.tables.sendTasks[0].status, "pending");
  assert.equal(e.tables.sendTasks[0].retryCount, 1);
  assert.equal(e.tables.subscriptions[0].remaining, 20);
  assert.equal(e.tables.preferences[0].targetAuLow, true);
});

test("invalid prices never become zero-yuan broadcasts", async () => {
  const e = engine({ quoteFields: { f43: "-" }, tables: { preferences: [{ ...prefs, targetAuLow: false, scheduledBrief: true, scheduledTime: "09:00" }], subscriptions: subs } });
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 0);
  assert.equal(e.tables.subscriptions[1].remaining, 20);
});

test("unsent daily alert cancelled by edited threshold can trigger again with the new threshold", async () => {
  const e = engine({ tables: { preferences: [{ ...prefs, targetAuLow: false, volatilityAu: true, volatilityPct: 1 }], subscriptions: subs } });
  await e.main({ TriggerName: "scanTimer" });
  e.tables.preferences[0].volatilityPct = 2;
  e.advance(60000);
  await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.tables.sendTasks[0].status, "cancelled");
  e.tables.preferences[0].volatilityPct = 0.5;
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.sendTasks[0].meta.threshold, 0.5);
});

test("scan paginates users rather than silently omitting users after the first 100", async () => {
  const users = Array.from({ length: 105 }, (_, i) => ({ _id: String(i).padStart(3, "0"), openid: "u" + i, scheduledBrief: true, scheduledTime: "09:00" }));
  const e = engine({ tables: { preferences: users } });
  await e.main({ TriggerName: "scanTimer" });
  assert.equal(e.tables.sendTasks.length, 105);
});

test("confirmed sent status survives autooff write failure and the next scan repairs the switch", async () => {
  let failOnce = true;
  const e = engine({ beforeUpdate(name, filter, data) {
    if (name === "preferences" && data.targetAuLow === false && failOnce) {
      failOnce = false;
      throw new Error("temporary preferences write failure");
    }
  } });
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.sendTasks[0].status, "sent");
  assert.equal(e.tables.preferences[0].targetAuLow, true);
  await scanAndDispatch(e);
  assert.equal(e.tables.preferences[0].targetAuLow, false);
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.subscriptions[0].remaining, 19);
});

test("unknown send outcome is never refunded or automatically resent", async () => {
  const e = engine({ sendError: { errMsg: "network disconnected after send" } });
  await scanAndDispatch(e);
  await scanAndDispatch(e);
  assert.equal(e.tables.sendTasks[0].status, "pending-check");
  assert.equal(e.tables.subscriptions[0].remaining, 19);
});

test("abandoned processing tasks become pending-check instead of duplicate sends", async () => {
  const e = engine({ tables: { preferences: [prefs], subscriptions: subs, sendTasks: [{ _id: "old", status: "processing", updatedAt: 1 }] } });
  await e.main({});
  assert.equal(e.tables.sendTasks[0].status, "pending-check");
  assert.equal(e.sent.length, 0);
});

test("a stale dispatch snapshot cannot reclaim a task that another worker already requeued", async () => {
  let requeued = false;
  const e = engine({ beforeUpdate(name, filter, data, tables) {
    if (name === "sendTasks" && data.status === "processing" && !requeued) {
      requeued = true;
      const row = tables.sendTasks.find(t => t._id === filter._id);
      row.triggerTime += 5 * 60000;
      row.retryCount = 1;
    }
  } });
  await scanAndDispatch(e);
  assert.equal(e.sent.length, 0);
  assert.equal(e.tables.sendTasks[0].retryCount, 1);
  e.advance(5 * 60000);
  await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.sent.length, 1);
});

test("sent target autooff repair runs even if the price no longer meets the target", async () => {
  const e = engine({ tables: {
    preferences: [{ ...prefs, targetAuLowPrice: 800 }], subscriptions: subs,
    sendTasks: [{ _id: "targetAuLow:u:r1", type: "targetAuLow", openid: "u", status: "sent", sentAt: Date.parse("2026-10-27T08:59:00+08:00"), meta: { ruleId: "r1" } }]
  } });
  await e.main({ TriggerName: "scanTimer" });
  assert.equal(e.tables.preferences[0].targetAuLow, false);
  assert.equal(e.sent.length, 0);
});

test("minute timer detects and sends a target in the same invocation", async () => {
  const e = engine();
  const result = await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.sent.length, 1);
  assert.equal(result.processed, 1);
  assert.equal(e.tables.sendTasks[0].sentAt, e.now());
  await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.sent.length, 1);
});

test("minute timer sends daily volatility as soon as a quote meets the threshold", async () => {
  const e = engine({ tables: { preferences: [{ ...prefs, targetAuLow: false, volatilityAu: true, volatilityPct: 1 }], subscriptions: subs } });
  await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.sent.length, 1);
  assert.equal(e.tables.sendTasks[0].type, "volAu");
});

test("one-minute samples retain enough history for short moves after warmup", async () => {
  const e = engine({ tables: { preferences: [{ ...prefs, targetAuLow: false, shortAu: true, shortPct: 1 }], subscriptions: subs } });
  for (let minute = 0; minute <= 16; minute++) {
    await e.main({ TriggerName: "scanTimer" });
    if (minute === 0) e.tables.quoteSnapshots[0].samples[0].au.price = 920;
    if (minute < 16) e.advance(60000);
  }
  const samples = e.tables.quoteSnapshots[0].samples;
  assert.equal(samples.length, 17);
  assert.equal(e.tables.sendTasks[0].type, "shortAu");
  assert.equal(e.tables.sendTasks[0].triggerTime <= e.now(), true);
});

test("minute timer still dispatches queued tasks when scanning fails", async () => {
  let failScan = false;
  const e = engine({ beforeUpdate(name, filter, data) {
    if (failScan && name === "preferences") throw new Error("scan failed");
  } });
  await e.main({ TriggerName: "scanTimer" });
  // A previously sent target requires switch repair, which fails during this scan.
  e.tables.sendTasks.push({ _id: "targetAuLow:u:r2", type: "targetAuLow", openid: "u", status: "sent", meta: { ruleId: "r2" } });
  e.tables.preferences.push({ ...prefs, _id: "other", openid: "u", targetAuLowRuleId: "r2" });
  failScan = true;
  e.advance(60000);
  const result = await e.main({ TriggerName: "dispatchTimer" });
  assert.equal(e.sent.length, 1);
  assert.equal(result.ok, false);
  assert.match(result.scanError, /scan failed/);
});

test("minute timer sends multi-asset price and daily moves without another timer", async () => {
  const { memoryDb } = require("./helpers/asset-db");
  for (const type of ["priceAbove", "priceBelow", "dailyMove", "rapidMove"]) {
    const time = Date.parse("2026-10-27T09:02:00+08:00");
    const asset = { id: "sh600519", name: "贵州茅台", precision: 2, unit: "元/股", currency: "CNY" };
    const q = { assetId: asset.id, price: 900, changePct: -1.1, sourceTime: time, fetchedAt: time, source: "tencent", stale: false };
    const rule = { id: "r", version: "v1", assetId: asset.id, type, value: type.startsWith("price") ? 900 : 1, enabled: true };
    const { db, tables } = memoryDb({
      preferences: [{ _id: "u", openid: "u", multiAssetVersion: 1 }],
      portfolios: [{ _id: "u", openid: "u", migrationVersion: 1, items: [asset.id], rules: [rule] }],
      subscriptions: [{ _id: "u:" + templates.volatility, openid: "u", templateId: templates.volatility, remaining: 20 }],
      quoteSnapshots: [{ _id: "asset:" + asset.id, samples: [{ ...q, price: 920, at: time - 15 * 60000, sourceTime: time - 15 * 60000 }] }]
    });
    const e = loadEngine({ db, tables, callFunction: async () => ({ result: { ok: true, assets: [asset], quotes: [q] } }) });
    await e.main({ TriggerName: "dispatchTimer" });
    assert.equal(e.sent.length, 1, type);
    assert.equal(tables.sendTasks[0].sentAt, time, type);
    assert.equal(tables.subscriptions[0].remaining, 19, type);
    await e.main({ TriggerName: "dispatchTimer" });
    assert.equal(e.sent.length, 1, type);
  }
});
