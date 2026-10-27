const assert = require("node:assert/strict");
const { test } = require("node:test");
const { planTasks, isTaskCurrent, withinLimit, freshPrice } = require("../cloudfunctions/sendTask/rules");

const now = Date.parse("2026-10-27T09:02:00+08:00");
const user = { openid: "u", dailyBrief: false };
const quotes = {
  au: { price: 900, prevClose: 910, pct: -1.1, sourceAt: now },
  intl: { usd: 4000, prevClose: 3960, pct: 1.01, sourceAt: now }
};
const target = { ...user, targetAuLow: true, targetAuLowPrice: 900, targetAuLowRuleId: "r1" };

test("target equality triggers once with version-based stable id and captured price", () => {
  const [task] = planTasks(target, quotes, [], now);
  assert.equal(task._id, "targetAuLow:u:r1");
  assert.equal(task.type, "targetAuLow");
  assert.equal(task.meta.targetPrice, 900);
  assert.equal(task.meta.ruleId, "r1");
  assert.equal(planTasks(target, quotes, [], now + 1000)[0]._id, task._id);
});

test("all four target types use their own market and direction", () => {
  for (const [key, value] of [["targetAuLow", 900], ["targetAuHigh", 899], ["targetXauLow", 4001], ["targetXauHigh", 4000]]) {
    assert.equal(planTasks({ ...user, [key]: true, [key + "Price"]: value, [key + "RuleId"]: "r" }, quotes, [], now)[0].type, key);
  }
  assert.equal(planTasks({ ...target, targetAuLowPrice: 899 }, quotes, [], now).length, 0);
});

test("targets never use missing, stale, zero, or NaN quotes", () => {
  for (const q of [null, { price: null, sourceAt: now }, { price: 0, sourceAt: now }, { price: NaN, sourceAt: now }, { price: 800, sourceAt: now - 3600000 }]) {
    assert.equal(planTasks(target, { au: q }, [], now).length, 0);
  }
  assert.equal(freshPrice({ price: 900 }, "au", now), null);
});

test("scheduled broadcast accepts arbitrary minute and respects weekdays", () => {
  const prefs = { ...user, scheduledBrief: true, scheduledTime: "09:01", scheduledWeekdaysOnly: true };
  const [task] = planTasks(prefs, quotes, [], now);
  assert.equal(task.type, "scheduledBrief");
  assert.equal(task._id, "scheduledBrief:u:20261027");
  assert.equal(planTasks(prefs, quotes, [], Date.parse("2026-10-27T08:59:00+08:00")).length, 0);
  assert.equal(planTasks(prefs, quotes, [], Date.parse("2026-10-27T09:10:00+08:00")).length, 0);
  const sunday = Date.parse("2026-11-01T09:02:00+08:00");
  assert.equal(planTasks(prefs, quotes, [], sunday).length, 0);
  assert.equal(planTasks({ ...prefs, scheduledWeekdaysOnly: false }, quotes, [], sunday).length, 1);
});

test("23:59 scheduled broadcast is picked up by the next midnight scan with previous date identity", () => {
  const prefs = { ...user, scheduledBrief: true, scheduledTime: "23:59", scheduledWeekdaysOnly: true };
  const tasks = planTasks(prefs, {}, [], Date.parse("2026-10-28T00:00:00+08:00"));
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0]._id, "scheduledBrief:u:20261027");
  // 星期五的播报可在跨入周六后的扫描补上，周日的工作日播报不能在周一补发。
  assert.equal(planTasks(prefs, {}, [], Date.parse("2026-10-31T00:00:00+08:00")).length, 1);
  assert.equal(planTasks(prefs, {}, [], Date.parse("2026-11-02T00:00:00+08:00")).length, 0);
});

test("daily volatility uses selected threshold, each market once a day", () => {
  const prefs = { ...user, volatilityAu: true, volatilityXau: true, volatilityPct: 1 };
  const tasks = planTasks(prefs, quotes, [], now);
  assert.deepEqual(tasks.map(t => t.type), ["volAu", "volXau"]);
  assert.equal(planTasks({ ...prefs, volatilityPct: 2 }, quotes, [], now).length, 0);
});

test("short moves need a fresh 15-minute baseline and honor chosen threshold", () => {
  const prefs = { ...user, shortAu: true, shortXau: true, shortPct: 1 };
  const sample = { at: now - 15 * 60000, au: { price: 920, sourceAt: now - 15 * 60000 }, intl: { usd: 3900, sourceAt: now - 15 * 60000 } };
  assert.deepEqual(planTasks(prefs, quotes, [sample], now).map(t => t.type), ["shortAu", "shortXau"]);
  assert.equal(planTasks(prefs, quotes, [], now).length, 0);
  assert.equal(planTasks(prefs, quotes, [{ ...sample, at: now - 60 * 60000 }], now).length, 0);
  assert.equal(planTasks({ ...prefs, shortPct: 5 }, quotes, [sample], now).length, 0);
  assert.equal(planTasks(prefs, quotes, [{ ...sample, au: { price: 920, sourceAt: now } , intl: null }], now).length, 0);
});

test("editing, closing or rearming a target invalidates previous task", () => {
  const [task] = planTasks(target, quotes, [], now);
  assert.equal(isTaskCurrent(task, target), true);
  assert.equal(isTaskCurrent(task, { ...target, targetAuLow: false }), false);
  assert.equal(isTaskCurrent(task, { ...target, targetAuLowRuleId: "r2" }), false);
  assert.equal(isTaskCurrent(task, { ...target, targetAuLowPrice: 899 }), false);
});

test("changing a schedule or threshold cancels the outdated pending task", () => {
  const prefs = { ...user, scheduledBrief: true, scheduledTime: "09:00", volatilityAu: true, volatilityPct: 1 };
  for (const task of planTasks(prefs, quotes, [], now)) {
    assert.equal(isTaskCurrent(task, prefs), true);
    assert.equal(isTaskCurrent(task, { ...prefs, scheduledTime: "10:00", volatilityPct: 2 }), false);
  }
});

test("target budgets remain available after all six ordinary categories were sent", () => {
  const counts = { dailyBrief: 1, scheduledBrief: 1, volAu: 1, volXau: 1, shortAu: 1, shortXau: 1 };
  assert.equal(withinLimit("targetAuLow", counts), true);
  assert.equal(withinLimit("targetAuLow", { ...counts, targetAuLow: 1 }), false);
  assert.equal(withinLimit("shortAu", counts), false);
  assert.equal(withinLimit("unknown", {}), false);
});
