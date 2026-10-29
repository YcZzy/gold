const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHandler } = require("../cloudfunctions/portfolio");
function setup(seed = {}, options = {}) {
  let data = structuredClone(seed),
    queue = Promise.resolve();
  const api = (state) => ({
    collection(c) {
      return {
        doc(id) {
          return {
            async get() {
              if (options.failTaskRead && c === "sendTasks")
                throw new Error("database timeout");
              if (!state[c]?.[id])
                throw Object.assign(new Error("document does not exist"), {
                  code: "DOCUMENT_NOT_FOUND",
                });
              return { data: structuredClone(state[c][id]) };
            },
            async set({ data: d }) {
              (state[c] ||= {})[id] = structuredClone(d);
            },
            async update({ data: d }) {
              if (options.failMarker && c === "preferences")
                throw new Error("write failed");
              Object.assign(state[c][id], structuredClone(d));
            },
          };
        },
      };
    },
  });
  const db = {
    ...api(data),
    runTransaction(fn) {
      const work = queue.then(async () => {
        const draft = structuredClone(data);
        const result = await fn(api(draft));
        data = draft;
        return result;
      });
      queue = work.catch(() => {});
      return work;
    },
  };
  const main = createHandler({
    db,
    getOpenid: () => "caller",
    resolve: async (id) => ({
      id,
      name: id,
      code: id.slice(2),
      market: id.startsWith("sh") ? "SH" : "SZ",
      kind: "stock",
      currency: "CNY",
      unit: "元",
      secid: id,
      quoteCode: id,
      precision: 2,
    }),
  });
  return { main, data: () => data, transaction: (fn) => db.runTransaction(fn) };
}
test("migration atomic, preserves prefs, carries old revision and is idempotent", async () => {
  const f = setup({
    preferences: {
      caller: {
        theme: "blackgold",
        remaining: 8,
        targetAuHigh: true,
        targetAuHighPrice: 800,
        targetAuHighRuleId: "legacy",
      },
    },
  });
  const a = await f.main({ action: "list" });
  assert.equal(a.ok, true);
  assert.equal(a.items.length, 2);
  assert.equal(a.rules.find((r) => r.type === "priceAbove").version, "legacy");
  assert.equal(a.rules.find((r) => r.type === "close").enabled, true);
  assert.equal(f.data().preferences.caller.theme, "blackgold");
  assert.equal(f.data().preferences.caller.remaining, 8);
  assert.equal(f.data().preferences.caller.multiAssetVersion, 1);
  assert.deepEqual((await f.main({ action: "list" })).rules, a.rules);
});
test("concurrent additions serialize free cap, duplicates idempotent and expired VIP free", async () => {
  const f = setup({ entitlements: { caller: { tier: "vip", expiresAt: 1 } } });
  await f.main({ action: "list" });
  const results = await Promise.all(
    ["sh600519", "sz000001", "sh600000", "sz000002"].map((assetId) =>
      f.main({ action: "add", assetId }),
    ),
  );
  assert.equal(results.filter((r) => r.ok).length, 3);
  assert.equal(f.data().portfolios.caller.items.length, 5);
  assert.equal((await f.main({ action: "add", assetId: "sh600519" })).ok, true);
});
test("rule identity, rearm, removal deletes rules, reorder rejects stale/incomplete", async () => {
  const f = setup();
  const first = await f.main({
    action: "saveRule",
    assetId: "gold-au9999",
    type: "priceAbove",
    enabled: true,
    value: 800,
  });
  const rule = first.rules.find((r) => r.type === "priceAbove");
  assert.equal(
    (
      await f.main({
        action: "saveRule",
        assetId: "gold-au9999",
        type: "priceAbove",
        enabled: true,
        value: 800,
      })
    ).rules.find((r) => r.id === rule.id).version,
    rule.version,
  );
  await f.main({
    action: "saveRule",
    assetId: "gold-au9999",
    type: "priceAbove",
    enabled: false,
    value: 800,
  });
  const rearm = await f.main({
    action: "saveRule",
    assetId: "gold-au9999",
    type: "priceAbove",
    enabled: true,
    value: 800,
  });
  assert.notEqual(
    rearm.rules.find((r) => r.id === rule.id).version,
    rule.version,
  );
  assert.equal(
    (
      await f.main({
        action: "reorder",
        assetIds: ["gold-xauusd"],
        revision: rearm.revision,
      })
    ).ok,
    false,
  );
  const removed = await f.main({ action: "remove", assetId: "gold-au9999" });
  assert.equal(removed.rules.filter(r => r.assetId === "gold-au9999").length, 0);
  const addedAgain = await f.main({ action: "add", assetId: "gold-au9999" });
  assert.equal(addedAgain.rules.filter(r => r.assetId === "gold-au9999").length, 0);
  await f.main({ action: "remove", assetId: "gold-au9999" });
  assert.equal(
    (
      await f.main({
        action: "saveRule",
        assetId: "gold-au9999",
        type: "priceAbove",
        enabled: true,
        value: 800,
      })
    ).ok,
    false,
  );
  assert.equal(
    (
      await f.main({
        action: "reorder",
        assetIds: ["gold-xauusd"],
        revision: 0,
      })
    ).ok,
    false,
  );
});
test("malformed known fields reject and unknown identity never accepted", async () => {
  const f = setup();
  for (const patch of [
    { enabled: "true" },
    { value: NaN },
    { value: 0 },
    { time: "25:01" },
    { weekdaysOnly: 1 },
  ])
    assert.equal(
      (
        await f.main({
          action: "saveRule",
          assetId: "gold-au9999",
          type: "priceAbove",
          enabled: true,
          value: 800,
          ...patch,
        })
      ).ok,
      false,
    );
  assert.equal(
    (await f.main({ action: "add", assetId: "victim", openid: "victim" })).ok,
    false,
  );
  assert.equal((await f.main({ action: "list", openid: "victim" })).ok, true);
  assert.ok(!f.data().portfolios.victim);
});
test("migration rollback includes prefs marker and embedded rules", async () => {
  const f = setup(
    { preferences: { caller: { theme: "paper", dailyBrief: true } } },
    { failMarker: true },
  );
  const result = await f.main({ action: "list" });
  assert.equal(result.ok, false);
  assert.equal(f.data().portfolios, undefined);
  assert.equal(f.data().preferences.caller.multiAssetVersion, undefined);
});
test("concurrent engine consume and unrelated save cannot resurrect one-shot", async () => {
  const f = setup();
  const initial = await f.main({
    action: "saveRule",
    assetId: "gold-au9999",
    type: "priceBelow",
    value: 700,
    enabled: true,
  });
  const target = initial.rules.find((r) => r.type === "priceBelow");
  await Promise.all([
    f.transaction(async (tx) => {
      const ref = tx.collection("portfolios").doc("caller");
      const doc = (await ref.get()).data;
      const r = doc.rules.find(
        (r) => r.id === target.id && r.version === target.version,
      );
      r.enabled = false;
      doc.revision++;
      await ref.set({ data: doc });
    }),
    f.main({
      action: "saveRule",
      assetId: "gold-xauusd",
      type: "priceAbove",
      value: 4000,
      enabled: true,
    }),
  ]);
  const result = await f.main({ action: "list" });
  assert.equal(result.rules.find((r) => r.id === target.id).enabled, false);
  assert.equal(
    result.rules.find(
      (r) => r.assetId === "gold-xauusd" && r.type === "priceAbove",
    ).enabled,
    true,
  );
});
test("valid server VIP unlocks 30 items; client tier has no effect; full permutation revision", async () => {
  const f = setup({
    entitlements: { caller: { tier: "vip", expiresAt: Date.now() + 60000 } },
  });
  let result;
  for (const id of ["sh600519", "sz000001", "sh600000", "sz000002"])
    result = await f.main({ action: "add", assetId: id });
  assert.equal(result.items.length, 6);
  assert.equal(result.limits.tier, "vip");
  const ids = result.items.map((i) => i.id).reverse();
  const ordered = await f.main({
    action: "reorder",
    assetIds: ids,
    revision: result.revision,
  });
  assert.deepEqual(
    ordered.items.map((i) => i.id),
    ids,
  );
  assert.equal(
    (
      await f.main({
        action: "reorder",
        assetIds: ids,
        revision: result.revision,
      })
    ).err,
    "revision-conflict",
  );
  const free = setup();
  assert.equal(
    (
      await free.main({
        action: "list",
        tier: "vip",
        expiresAt: Date.now() + 999999,
      })
    ).limits.tier,
    "free",
  );
});
test("30 active rules enforced transactionally, removal frees active capacity", async () => {
  const f = setup({
    entitlements: { caller: { tier: "vip", expiresAt: Date.now() + 60000 } },
  });
  for (const assetId of ["sh600519", "sz000001", "sh600000", "sz000002"])
    await f.main({ action: "add", assetId });
  let last;
  for (const assetId of [
    "gold-au9999",
    "gold-xauusd",
    "sh600519",
    "sz000001",
    "sh600000",
  ])
    for (const type of [
      "priceAbove",
      "priceBelow",
      "dailyMove",
      "rapidMove",
      "scheduled",
      "close",
    ]) {
      if (assetId === "gold-xauusd" && type === "close") continue;
      last = await f.main({
        action: "saveRule",
        assetId,
        type,
        enabled: true,
        value: 1,
        time: "09:00",
      });
    }
  last = await f.main({
    action: "saveRule",
    assetId: "sz000002",
    type: "scheduled",
    time: "09:00",
    enabled: true,
  });
  assert.equal(last.rules.filter((r) => r.enabled).length, 30);
  assert.equal(
    (
      await f.main({
        action: "saveRule",
        assetId: "sz000002",
        type: "close",
        enabled: true,
      })
    ).err,
    "rule-limit",
  );
  await f.main({ action: "remove", assetId: "sh600000" });
  assert.equal(
    (
      await f.main({
        action: "saveRule",
        assetId: "sz000002",
        type: "close",
        enabled: true,
      })
    ).ok,
    true,
  );
});
test("client offline list labelled; writes reject; server error hint retained", async () => {
  const { createClient } = require("../utils/portfolio-client");
  const offline = createClient({
    cloud: {
      callFunction: async () => {
        throw new Error("timeout");
      },
    },
  });
  const result = await offline.list();
  assert.equal(result.offline, true);
  assert.equal(result.items.length, 2);
  await assert.rejects(
    () => offline.add("sh600519"),
    (e) => !!e.hint,
  );
  const errors = createClient({
    cloud: {
      callFunction: async () => ({
        result: { ok: false, err: "watchlist-limit", hint: "数量已满" },
      }),
    },
  });
  await assert.rejects(
    () => errors.list(),
    (e) => e.code === "watchlist-limit" && e.hint === "数量已满",
  );
});
test("threshold whitelist, price precision, and verified closing market scope", async () => {
  const f = setup();
  for (const [assetId, type, value] of [
    ["gold-au9999", "dailyMove", 4],
    ["gold-au9999", "rapidMove", 0.001],
    ["gold-au9999", "priceAbove", 10.001],
    ["gold-au9999", "priceBelow", 1000001],
    ["gold-xauusd", "close", 1],
  ])
    assert.equal(
      (
        await f.main({
          action: "saveRule",
          assetId,
          type,
          value,
          enabled: true,
        })
      ).ok,
      false,
    );
  assert.equal(
    (
      await f.main({
        action: "saveRule",
        assetId: "gold-xauusd",
        type: "scheduled",
        time: "17:00",
        enabled: true,
      })
    ).ok,
    true,
  );
});

test("gold metadata matches market service and client defaults", () => {
  const { GOLD } = require("../cloudfunctions/portfolio");
  const { DEFAULT_ITEMS } = require("../utils/portfolio-client");
  assert.deepEqual(DEFAULT_ITEMS, Object.values(GOLD));
  assert.equal(GOLD["gold-au9999"].name, "沪金 Au99.99");
  assert.equal(GOLD["gold-xauusd"].code, "XAU");
  assert.ok(DEFAULT_ITEMS.every((asset) => asset.quoteCode === null));
});

test("failed operation does not initialize portfolio when legacy marker already exists", async () => {
  const f = setup({
    preferences: { caller: { theme: "blackgold", multiAssetVersion: 1 } },
  });
  const result = await f.main({
    action: "reorder",
    assetIds: ["gold-au9999"],
    revision: 0,
  });
  assert.equal(result.ok, false);
  assert.equal(f.data().portfolios, undefined);
  assert.equal(f.data().preferences.caller.theme, "blackgold");
});

for (const status of ["sent", "pending-check", "processing"]) {
  test(`migration keeps previously ${status} legacy targets inactive across days`, async () => {
    const taskId = "targetAuHigh:caller:legacy-version";
    const oldTask = { status, updatedAt: Date.now() - 86400000, remaining: 5 };
    const f = setup({
      preferences: {
        caller: {
          targetAuHigh: true,
          targetAuHighPrice: 800,
          targetAuHighRuleId: "legacy-version",
        },
      },
      sendTasks: { [taskId]: oldTask },
    });
    const result = await f.main({ action: "list" });
    assert.equal(result.ok, true);
    const target = result.rules.find((rule) => rule.type === "priceAbove");
    assert.equal(target.enabled, false);
    assert.equal(target.version, "legacy-version");
    assert.deepEqual(f.data().sendTasks[taskId], oldTask);
    const again = await f.main({ action: "list" });
    assert.equal(
      again.rules.find((rule) => rule.id === target.id).enabled,
      false,
    );
    const armed = await f.main({
      action: "saveRule",
      assetId: target.assetId,
      type: target.type,
      value: target.value,
      enabled: true,
    });
    assert.notEqual(
      armed.rules.find((rule) => rule.id === target.id).version,
      target.version,
    );
  });
}

test("legacy target task read failures abort migration without marker or portfolio", async () => {
  const f = setup(
    {
      preferences: {
        caller: {
          theme: "blackgold",
          targetXauLow: true,
          targetXauLowPrice: 2500,
          targetXauLowRuleId: "old",
        },
      },
    },
    { failTaskRead: true },
  );
  const result = await f.main({ action: "list" });
  assert.equal(result.ok, false);
  assert.equal(f.data().portfolios, undefined);
  assert.equal(f.data().preferences.caller.multiAssetVersion, undefined);
  assert.equal(f.data().preferences.caller.theme, "blackgold");
});

test('client exposes last confirmed portfolio synchronously without inventing a default', async () => {
  const { createClient } = require('../utils/portfolio-client');
  let stored;
  const result = { ok: true, items: [{ id: 'sh600519' }], rules: [], revision: 2 };
  const client = createClient({
    getStorageSync: () => stored,
    setStorageSync: (key, value) => { if (key === 'portfolio-cache-v1') stored = value; },
    cloud: { callFunction: async () => ({ result }) },
  });
  assert.equal(client.getCached(), null);
  await client.add('sh600519');
  assert.deepEqual(client.getCached(), result);
  client.getCached().items.length = 0;
  assert.equal(client.getCached().items.length, 1);
  assert.deepEqual(createClient({ getStorageSync: () => stored }).getCached(), result);
});

test('late portfolio list cannot overwrite cache after a newer mutation', async () => {
  const { createClient } = require('../utils/portfolio-client');
  let finish;
  const fresh = { ok: true, items: [{ id: 'sh600519' }], rules: [], revision: 3 };
  const client = createClient({
    setStorageSync() {},
    cloud: { callFunction: ({ data }) => data.action === 'list'
      ? new Promise(r => { finish = r; }) : Promise.resolve({ result: fresh }) },
  });
  const listing = client.list();
  await client.add('sh600519');
  finish({ result: { ...fresh, items: [], revision: 2 } });
  await listing;
  assert.equal(client.getCached().revision, 3);
  assert.equal(client.getCached().items.length, 1);
});
