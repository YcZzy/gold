const crypto = require("crypto");
const securities = require("./securities");
const hasOwn = (object, key) =>
  Object.prototype.hasOwnProperty.call(object, key);
const GOLD = {
  "gold-au9999": {
    id: "gold-au9999",
    name: "沪金 Au99.99",
    code: "AU9999",
    market: "SGE",
    kind: "gold",
    currency: "CNY",
    unit: "元/克",
    secid: "118.AU9999",
    quoteCode: null,
    precision: 2,
  },
  "gold-xauusd": {
    id: "gold-xauusd",
    name: "伦敦金现",
    code: "XAU",
    market: "GLOBAL",
    kind: "gold",
    currency: "USD",
    unit: "美元/盎司",
    secid: "122.XAU",
    quoteCode: null,
    precision: 2,
  },
};
const TYPES = [
  "priceAbove",
  "priceBelow",
  "dailyMove",
  "rapidMove",
  "scheduled",
  "close",
];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const validId = securities.validId;
const token = () => crypto.randomBytes(16).toString("hex");
function fail(err, hint) {
  throw Object.assign(new Error(hint), { businessCode: err });
}
async function read(doc) {
  try {
    return (await doc.get()).data;
  } catch (e) {
    if (
      e.code === "DOCUMENT_NOT_FOUND" ||
      e.errCode === "DATABASE_DOCUMENT_NOT_EXIST" ||
      /document(?: with _id [^\r\n]+?)? (?:does not exist|not exists?|not found)\b/i.test(
        [e.message, e.errMsg].filter(Boolean).join(" "),
      )
    )
      return null;
    throw e;
  }
}
function limitsFor(ent, now) {
  // Membership is server-owned; expired or unknown tiers always use free limits.
  const vip = !!(
    ent &&
    ent.tier === "vip" &&
    typeof ent.expiresAt === "number" &&
    Number.isFinite(ent.expiresAt) &&
    ent.expiresAt > now
  );
  return {
    watchlist: vip ? 30 : 5,
    activeRules: 30,
    tier: vip ? "vip" : "free",
    expiresAt: vip ? ent.expiresAt : null,
  };
}
function migrate(prefs, now, legacyStates = {}) {
  const rules = [];
  const add = (assetId, type, enabled, extra = {}, version) => {
    if (!enabled && type !== "close" && !hasOwn(extra, "value")) return;
    rules.push({
      id: token(),
      assetId,
      type,
      enabled: !!enabled,
      ...extra,
      version: typeof version === "string" && version ? version : token(),
      createdAt: now,
      updatedAt: now,
    });
  };
  add("gold-au9999", "close", prefs.dailyBrief !== false);
  if (prefs.scheduledBrief)
    add("gold-au9999", "scheduled", true, {
      time: TIME.test(prefs.scheduledTime) ? prefs.scheduledTime : "09:00",
      weekdaysOnly: prefs.scheduledWeekdaysOnly !== false,
    });
  for (const [suffix, assetId] of [
    ["Au", "gold-au9999"],
    ["Xau", "gold-xauusd"],
  ]) {
    if (prefs["volatility" + suffix])
      add(assetId, "dailyMove", true, {
        value: positive(prefs.volatilityPct) ? prefs.volatilityPct : 1.5,
      });
    if (prefs["short" + suffix])
      add(assetId, "rapidMove", true, {
        value: positive(prefs.shortPct) ? prefs.shortPct : 1,
      });
    for (const [side, type] of [
      ["High", "priceAbove"],
      ["Low", "priceBelow"],
    ]) {
      const key = "target" + suffix + side;
      if (positive(prefs[key + "Price"]))
        add(
          assetId,
          type,
          prefs[key] &&
            !["sent", "pending-check", "processing"].includes(
              legacyStates[key],
            ),
          { value: prefs[key + "Price"] },
          prefs[key + "RuleId"],
        );
    }
  }
  return rules;
}
const positive = (v) =>
  typeof v === "number" && Number.isFinite(v) && v > 0 && v <= 1000000;
function conditions(event, asset) {
  if (!TYPES.includes(event.type) || typeof event.enabled !== "boolean")
    fail("bad-rule", "提醒类型或开关格式不正确");
  if (hasOwn(event, "value") && !positive(event.value))
    fail("bad-rule", "请输入有效的正数阈值");
  if (
    hasOwn(event, "time") &&
    (typeof event.time !== "string" || !TIME.test(event.time))
  )
    fail("bad-rule", "提醒时间格式应为 HH:mm");
  if (hasOwn(event, "weekdaysOnly") && typeof event.weekdaysOnly !== "boolean")
    fail("bad-rule", "交易日开关格式不正确");
  if (event.type === "close" && event.assetId === "gold-xauusd")
    fail("bad-rule", "国际黄金暂不支持收盘提醒，请使用定时提醒");
  if (event.type === "close" && event.enabled && asset && asset.supportsClose === false)
    fail("bad-rule", "该标的暂不支持收盘提醒，请使用定时提醒");
  const out = { enabled: event.enabled };
  const precision = asset && asset.precision != null ? asset.precision : 2;
  const pricePattern = precision === 0 ? /^\d+$/ : new RegExp("^\\d+(?:\\.\\d{1," + precision + "})?$");
  if (
    ["priceAbove", "priceBelow", "dailyMove", "rapidMove"].includes(event.type)
  ) {
    if (!positive(event.value)) fail("bad-rule", "请填写有效的提醒阈值");
    if (
      ["dailyMove", "rapidMove"].includes(event.type) &&
      ![0.5, 1, 1.5, 2, 3, 5].includes(event.value)
    )
      fail("bad-rule", "请选择支持的涨跌幅阈值");
    if (
      ["priceAbove", "priceBelow"].includes(event.type) &&
      !pricePattern.test(String(event.value))
    )
      fail("bad-rule", "目标价格最多保留 " + precision + " 位小数");
    out.value = event.value;
  }
  if (event.type === "scheduled") {
    if (typeof event.time !== "string" || !TIME.test(event.time))
      fail("bad-rule", "请设置提醒时间");
    out.time = event.time;
    out.weekdaysOnly = event.weekdaysOnly !== false;
  }
  return out;
}
function annotation(event) {
  if (typeof event.note !== "string" || !Array.isArray(event.tags) ||
      !event.tags.every(tag => typeof tag === "string") ||
      !Number.isSafeInteger(event.revision) || event.revision < 0)
    fail("bad-annotation", "备注、标签或版本格式不正确");
  const note = event.note.trim();
  const tags = [...new Set(event.tags.map(tag => tag.trim()).filter(Boolean))];
  if (Array.from(note).length > 120 || tags.length > 3 ||
      tags.some(tag => Array.from(tag).length > 8))
    fail("bad-annotation", "备注最多120字，标签最多3个且每个最多8字");
  return { note, tags };
}
function createHandler({ db, getOpenid, resolve, now = Date.now }) {
  return async (event = {}) => {
    const openid = getOpenid();
    if (!openid) return { ok: false, err: "no-openid", hint: "请先登录再操作" };
    try {
      const action = event.action || "list";
      if (
        ![
          "list",
          "add",
          "remove",
          "reorder",
          "saveRule",
          "saveAnnotation",
          "deleteRule",
        ].includes(action)
      )
        fail("bad-action", "不支持的操作");
      if (
        ["add", "remove", "saveRule", "saveAnnotation"].includes(action) &&
        !validId(event.assetId)
      )
        fail("bad-asset", "证券代码无效");
      let patch = null;
      const annotationPatch = action === "saveAnnotation" ? annotation(event) : null;
      if (
        action === "deleteRule" &&
        (typeof event.ruleId !== "string" || !event.ruleId)
      )
        fail("bad-rule", "提醒标识无效");
      if (
        action === "reorder" &&
        (!Array.isArray(event.assetIds) ||
          !event.assetIds.every(validId) ||
          !Number.isInteger(event.revision) ||
          event.revision < 0)
      )
        fail("bad-order", "自选顺序格式不正确");
      const metadata = { ...GOLD };
      async function asset(id) {
        if (!metadata[id]) {
          const found = await resolve(id);
          const verified = securities.metadata(found, id);
          if (!verified) fail("unknown-asset", "未找到可用的证券信息");
          metadata[id] = verified;
        }
        return metadata[id];
      }
      // Resolve remote metadata before entering the transaction: retries stay local.
      if (action === "add") await asset(event.assetId);
      if (action === "saveRule") patch = conditions(event, await asset(event.assetId));
      const saved = await db.runTransaction(async (tx) => {
        const ref = tx.collection("portfolios").doc(openid),
          prefRef = tx.collection("preferences").doc(openid);
        // Complete every read before any write, as required by the cloud SDK.
        const existing = await read(ref),
          prefs = (await read(prefRef)) || {},
          ent = await read(tx.collection("entitlements").doc(openid));
        const timestamp = now(),
          limits = limitsFor(ent, timestamp);
        const doc = existing
          ? {
              ...existing,
              items: [...existing.items],
              annotations: { ...(existing.annotations || {}) },
              rules: existing.rules.map((r) => ({ ...r })),
            }
          : {
              openid,
              items: Object.keys(GOLD),
              rules: [],
              annotations: {},
              revision: 0,
              migrationVersion: 0,
            };
        delete doc._id;
        let changed = !existing;
        if (doc.migrationVersion !== 1) {
          // A legacy target may already have delivered even if its old auto-off failed.
          // Read deterministic task IDs in this transaction before persisting the migration.
          const legacyStates = {};
          for (const key of [
            "targetAuHigh",
            "targetAuLow",
            "targetXauHigh",
            "targetXauLow",
          ]) {
            const version = prefs[key + "RuleId"];
            if (typeof version !== "string" || !version) continue;
            const task = await read(
              tx.collection("sendTasks").doc(`${key}:${openid}:${version}`),
            );
            if (task) legacyStates[key] = task.status;
          }
          const mapped = migrate(prefs, timestamp, legacyStates);
          for (const rule of mapped)
            if (
              !doc.rules.some(
                (r) => r.assetId === rule.assetId && r.type === rule.type,
              )
            )
              doc.rules.push(rule);
          doc.migrationVersion = 1;
          changed = true;
        }
        if (action === "add" && !doc.items.includes(event.assetId)) {
          if (doc.items.length >= limits.watchlist)
            fail("watchlist-limit", "自选数量已达上限，请先移除一项");
          doc.items.push(event.assetId);
          changed = true;
        }
        if (action === "saveAnnotation") {
          if (event.revision !== doc.revision)
            fail("revision-conflict", "自选列表已更新，请刷新后重试");
          if (!doc.items.includes(event.assetId))
            fail("not-watched", "请先将该品种加入自选");
          const previous = doc.annotations[event.assetId];
          if (!annotationPatch.note && !annotationPatch.tags.length) {
            if (hasOwn(doc.annotations, event.assetId)) {
              delete doc.annotations[event.assetId];
              changed = true;
            }
          } else if (!previous || previous.note !== annotationPatch.note ||
              JSON.stringify(previous.tags) !== JSON.stringify(annotationPatch.tags)) {
            doc.annotations[event.assetId] = { ...annotationPatch, updatedAt: timestamp };
            changed = true;
          }
        }
        if (action === "remove") {
          if (hasOwn(doc.annotations, event.assetId)) {
            delete doc.annotations[event.assetId];
            changed = true;
          }
          const items = doc.items.filter((id) => id !== event.assetId);
          if (items.length !== doc.items.length) {
            doc.items = items;
            changed = true;
          }
          const rules = doc.rules.filter((rule) => rule.assetId !== event.assetId);
          if (rules.length !== doc.rules.length) {
            doc.rules = rules;
            changed = true;
          }
        }
        if (action === "reorder") {
          if (event.revision !== doc.revision)
            fail("revision-conflict", "自选列表已更新，请刷新后重试");
          if (
            event.assetIds.length !== doc.items.length ||
            new Set(event.assetIds).size !== doc.items.length ||
            event.assetIds.some((id) => !doc.items.includes(id))
          )
            fail("bad-order", "排序必须包含全部自选且不能重复");
          if (event.assetIds.some((id, i) => id !== doc.items[i])) {
            doc.items = [...event.assetIds];
            changed = true;
          }
        }
        if (action === "saveRule") {
          if (patch.enabled && !doc.items.includes(event.assetId))
            fail("not-watched", "请先将该品种加入自选");
          const index = doc.rules.findIndex(
              (r) => r.assetId === event.assetId && r.type === event.type,
            ),
            old = doc.rules[index];
          if (!old || Object.keys(patch).some((k) => old[k] !== patch[k])) {
            const rotate =
              !old ||
              (!old.enabled && patch.enabled) ||
              ["value", "time", "weekdaysOnly"].some(
                (k) => old[k] !== patch[k],
              );
            const rule = {
              id: old ? old.id : token(),
              assetId: event.assetId,
              type: event.type,
              ...patch,
              version: rotate ? token() : old.version,
              createdAt: old ? old.createdAt : timestamp,
              updatedAt: timestamp,
            };
            if (index < 0) doc.rules.push(rule);
            else doc.rules[index] = rule;
            changed = true;
          }
          if (doc.rules.filter((r) => r.enabled).length > limits.activeRules)
            fail("rule-limit", "启用的提醒数量已达上限");
        }
        if (action === "deleteRule") {
          const rules = doc.rules.filter((r) => r.id !== event.ruleId);
          if (rules.length !== doc.rules.length) {
            doc.rules = rules;
            changed = true;
          }
        }
        if (changed) {
          doc.revision = (doc.revision || 0) + 1;
          doc.updatedAt = timestamp;
          await ref.set({ data: doc });
        }
        // Marker and mapped rules commit together; unrelated preferences stay intact.
        if (prefs.multiAssetVersion !== 1) {
          if (Object.keys(prefs).length)
            await prefRef.update({ data: { multiAssetVersion: 1 } });
          else await prefRef.set({ data: { openid, multiAssetVersion: 1 } });
        }
        return { ...doc, limits };
      });
      const items = await Promise.all(saved.items.map(asset));
      return {
        ok: true,
        items,
        rules: saved.rules,
        annotations: saved.annotations,
        limits: saved.limits,
        revision: saved.revision,
      };
    } catch (e) {
      return {
        ok: false,
        err: e.businessCode || "portfolio-unavailable",
        hint: e.businessCode ? e.message : "自选服务暂不可用，请稍后重试",
      };
    }
  };
}
exports.createHandler = createHandler;
exports.GOLD = GOLD;
exports.main = async (event) => {
  const cloud = require("wx-server-sdk");
  cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
  return createHandler({
    db: cloud.database(),
    getOpenid: () => cloud.getWXContext().OPENID,
    resolve: async (assetId) => {
      const response = await cloud.callFunction({
        name: "marketData",
        data: { action: "resolve", assetId },
      });
      if (!response.result || !response.result.ok)
        fail(
          "unknown-asset",
          (response.result && response.result.hint) || "未找到该证券",
        );
      return response.result.asset;
    },
  })(event);
};
