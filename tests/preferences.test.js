const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");
const vm = require("node:vm");

const targets = ["targetAuLow", "targetAuHigh", "targetXauLow", "targetXauHigh"];
function load(name, initial, options = {}) {
  let prefs = initial && { ...initial };
  const writes = [];
  const db = { collection(collection) {
    const query = {
      doc(id) { assert.equal(id, "caller"); return query; },
      where(filter) { assert.equal(filter.openid, "caller"); return query; },
      orderBy() { return query; }, limit() { return query; },
      async get() {
        if (collection === "preferences") {
          if (options.readError) throw options.readError;
          if (!prefs) throw Object.assign(new Error("document.get:fail document does not exist"), { errCode: -1 });
          return { data: { ...prefs, _id: "caller" } };
        }
        return { data: collection === "sendTasks" ? options.tasks || [] : [] };
      },
      async set({ data }) { assert.ok(!("_id" in data)); writes.push({ type: "set", data }); prefs = { ...data }; },
      async update({ data }) {
        assert.ok(!("_id" in data));
        if (options.beforeUpdate) options.beforeUpdate(prefs);
        writes.push({ type: "update", data }); prefs = { ...prefs, ...data };
      }
    };
    return query;
  } };
  const cloud = { init() {}, database: () => db, getWXContext: () => ({ OPENID: options.noIdentity ? "" : "caller" }) };
  const context = { exports: {}, Date, require(module) { return module === "wx-server-sdk" ? cloud : require(module); } };
  vm.runInNewContext(readFileSync(join(__dirname, `../cloudfunctions/${name}/index.js`), "utf8"), context);
  return { main: context.exports.main, writes, prefs: () => prefs };
}
const save = (fn, prefs) => fn.main({ prefs });

test("new preferences include every reminder default and existing theme", async () => {
  const fn = load("savePrefs");
  const result = await save(fn, { theme: "blackgold", scheduledBrief: true });
  assert.equal(result.ok, true);
  assert.equal(result.prefs.scheduledBrief, true);
  assert.equal(result.prefs.scheduledTime, "09:00");
  assert.equal(result.prefs.scheduledWeekdaysOnly, true);
  assert.equal(result.prefs.volatilityPct, 1.5);
  assert.equal(result.prefs.shortPct, 1);
  assert.equal(result.prefs.shortAu, false);
  assert.equal(result.prefs.shortXau, false);
  assert.equal(result.prefs.theme, "blackgold");
  for (const key of targets) {
    assert.equal(result.prefs[key], false);
    assert.equal(result.prefs[key + "Price"], null);
    assert.equal(result.prefs[key + "RuleId"], null);
  }
});

test("all reminder categories accept valid settings", async () => {
  const patch = { scheduledBrief: true, scheduledTime: "23:59", scheduledWeekdaysOnly: false,
    volatilityPct: 5, shortAu: true, shortXau: true, shortPct: 0.5 };
  targets.forEach((key) => { patch[key] = true; patch[key + "Price"] = 888.88; });
  const fn = load("savePrefs");
  const result = await save(fn, patch);
  assert.equal(result.ok, true);
  for (const [key, value] of Object.entries(patch)) assert.equal(result.prefs[key], value);
  assert.equal(new Set(targets.map(key => result.prefs[key + "RuleId"])).size, 4);
});

for (const [key, value] of Object.entries({ scheduledBrief: 1, scheduledTime: "24:00", scheduledWeekdaysOnly: "true",
  dailyBrief: null, volatilityAu: "false", dndStart: "8:00", theme: "bad", volatilityPct: 4,
  shortAu: 1, shortXau: null, shortPct: "1", targetAuLow: 1,
  targetAuHighPrice: 10.001, targetXauLowPrice: 0, targetXauHighPrice: 1000001 })) {
  test(`invalid ${key} rejects the whole patch with Chinese feedback`, async () => {
    const fn = load("savePrefs", { theme: "paper" });
    const result = await save(fn, { theme: "blackgold", [key]: value });
    assert.equal(result.ok, false);
    assert.equal(result.err, "bad-prefs");
    assert.match(result.hint, /[\u4e00-\u9fff]/);
    assert.equal(fn.writes.length, 0);
  });
}
for (const key of targets) {
  test(`${key} requires a valid merged price and rotates server rule identity only on rule changes`, async () => {
    const fn = load("savePrefs", { [key]: false, [key + "Price"]: 100 });
    const first = await save(fn, { [key]: true, [key + "RuleId"]: "spoofed" });
    const id = first.prefs[key + "RuleId"];
    assert.match(id, /^[a-f\d-]{32,36}$/i);
    assert.notEqual(id, "spoofed");
    const same = await save(fn, { [key]: true, theme: "blackgold" });
    assert.equal(same.prefs[key + "RuleId"], id);
    const changed = await save(fn, { [key + "Price"]: 101.12 });
    assert.notEqual(changed.prefs[key + "RuleId"], id);
    await save(fn, { [key]: false });
    const enabled = await save(fn, { [key]: true });
    assert.notEqual(enabled.prefs[key + "RuleId"], changed.prefs[key + "RuleId"]);
    const invalid = load("savePrefs");
    assert.equal((await save(invalid, { [key]: true })).err, "bad-prefs");
    assert.equal(invalid.writes.length, 0);
  });
}

test("nonfinite, negative and fractional prices reject without writes", async () => {
  for (const price of [NaN, Infinity, -1, 0.001, "100"]) {
    const fn = load("savePrefs");
    assert.equal((await save(fn, { targetAuLowPrice: price, theme: "paper" })).err, "bad-prefs");
    assert.equal(fn.writes.length, 0);
  }
});

test("clearing an enabled rule price rejects; disabling and clearing together succeeds", async () => {
  const fn = load("savePrefs", { targetAuLow: true, targetAuLowPrice: 100, targetAuLowRuleId: "old" });
  assert.equal((await save(fn, { targetAuLowPrice: null })).err, "bad-prefs");
  assert.equal((await save(fn, { targetAuLow: false, targetAuLowPrice: null })).ok, true);
});

test("existing prefs update only permitted patch and do not resurrect concurrently consumed targets", async () => {
  const fn = load("savePrefs", { openid: "caller", remaining: 10, theme: "paper", targetAuLow: true,
    targetAuLowPrice: 100, targetAuLowRuleId: "old" }, { beforeUpdate(prefs) { prefs.targetAuLow = false; } });
  const result = await save(fn, { theme: "blackgold", openid: "victim", remaining: 999, targetAuLowRuleId: "spoofed", unknown: true });
  assert.equal(result.ok, true);
  assert.equal(fn.writes[0].type, "update");
  assert.deepEqual(Object.keys(fn.writes[0].data).sort(), ["theme", "updatedAt"]);
  assert.equal(fn.prefs().targetAuLow, false);
  assert.equal(result.prefs.targetAuLow, false);
  assert.ok(!("_id" in result.prefs));
  assert.equal(fn.prefs().openid, "caller");
  assert.equal(fn.prefs().remaining, 10);
});

test("unknown-only input and missing caller do not write", async () => {
  const fn = load("savePrefs");
  assert.equal((await save(fn, { openid: "victim", remaining: 99, targetAuLowRuleId: "spoofed" })).err, "bad-prefs");
  assert.equal(fn.writes.length, 0);
  assert.equal((await save(load("savePrefs", null, { noIdentity: true }), { theme: "paper" })).err, "no-openid");
});

test("getStatus includes defaults and diagnostic task fields", async () => {
  const fn = load("getStatus", { theme: "blackgold" }, { tasks: [{ _id: "task", reason: "达到目标价", lastError: "发送失败", sentAt: 123 }] });
  const result = await fn.main();
  assert.equal(result.prefs.theme, "blackgold");
  assert.equal(result.prefs.scheduledTime, "09:00");
  assert.equal(result.prefs.scheduledBrief, false);
  assert.equal(result.prefs.shortPct, 1);
  assert.equal(result.prefs.volatilityPct, 1.5);
  for (const key of targets) assert.equal(result.prefs[key], false);
  assert.equal(result.recentTasks[0].reason, "达到目标价");
  assert.equal(result.recentTasks[0].lastError, "发送失败");
  assert.equal(result.recentTasks[0].sentAt, 123);
});

for (const name of ["savePrefs", "getStatus"]) {
  test(`${name} propagates preference read failures instead of treating them as absence`, async () => {
    for (const error of [Object.assign(new Error("database timeout"), { errCode: -1 }),
      Object.assign(new Error("permission denied"), { errCode: -502003 })]) {
      const fn = load(name, { targetAuLow: true }, { readError: error });
      await assert.rejects(() => name === "savePrefs" ? save(fn, { theme: "paper" }) : fn.main(),
        value => value === error);
      assert.equal(fn.writes.length, 0);
    }
  });
}

test("getStatus returns defaults when the preference document explicitly does not exist", async () => {
  const result = await load("getStatus").main();
  assert.equal(result.ok, true);
  assert.equal(result.prefs.targetAuLow, false);
  assert.equal(result.prefs.dailyBrief, true);
});
