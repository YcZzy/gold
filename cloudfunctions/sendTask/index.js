/**
 * 提醒任务处理（定时触发器驱动，关掉小程序也能跑）
 *
 * 触发器（config.json）：
 * - dispatchTimer：每分钟拉取行情、创建达标任务并立即分发
 * - scanTimer：兼容旧触发器/手动调用，仅执行扫描；部署时删除旧定时配置
 *
 * 发送链路（对应文档约定）：
 * 检查提醒开关 → 免打扰 → 剩余次数 → 任务有效期 → 原子预占额度 →
 * cloud.openapi.subscribeMessage.send → 成功扣次数 / 明确失败退回并按错误类型重试 /
 * 结果不明记 pending-check 不盲目重发 / 无授权资格记 no-auth
 *
 * 幂等：常规按用户+类型+日期，到价按用户+规则版本去重；原子认领任务、预占额度。
 */
const https = require("https");
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const { planTasks, isTaskCurrent, withinLimit, freshPrice, isBrief, positive, TARGET_KEYS } = require("./rules");
const { createAssetTasks } = require("./asset-tasks");

const T = {
  VOL_AU: "volAu"
};

// 与 utils/app-config.js 保持一致；全部提醒复用这两个已授权模板。
const TEMPLATE = {
  dailyBrief: "Wn6LX6JivcT9MkSoM81zR2uvcSFOEx3IuFLT5QXEVhw", // 每日数据更新通知
  volatility: "mQZ8fr72Xbf5nMlEjhP1ie9gl-2ndoeZa8_8upWsDYs" // 涨幅变动通知
};
const assetTasks = createAssetTasks({ db, cloud, templates: TEMPLATE });

const PAGE = "pages/index/index";
const MINIPROGRAM_STATE = "formal"; // 开发版联调时可临时改 "developer"

const STRATEGY = {
  dndStart: "23:00",
  dndEnd: "07:30",
  retryLimit: 3,
  retryDelayMs: 5 * 60 * 1000
};

const RETRYABLE = [-1, 45009]; // 系统繁忙 / 调用超限

// ---------- 时间（东八区） ----------

function bjParts(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return {
    ymd:
      d.getUTCFullYear() +
      String(d.getUTCMonth() + 1).padStart(2, "0") +
      String(d.getUTCDate()).padStart(2, "0"),
    weekday: d.getUTCDay(),
    hhmm: String(d.getUTCHours()).padStart(2, "0") + ":" + String(d.getUTCMinutes()).padStart(2, "0")
  };
}

/** 微信 time 字段要求的完整格式：yyyy-MM-dd HH:mm:ss */
function fmtDateTime(ts) {
  const d = new Date((ts || Date.now()) + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    p(d.getUTCMonth() + 1) +
    "-" +
    p(d.getUTCDate()) +
    " " +
    p(d.getUTCHours()) +
    ":" +
    p(d.getUTCMinutes()) +
    ":" +
    p(d.getUTCSeconds())
  );
}

function parseHM(s) {
  const p = String(s || "0:0").split(":");
  return Number(p[0]) * 60 + Number(p[1]);
}

function dayStartTs(ts) {
  const d = new Date(ts + 8 * 3600 * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 8 * 3600 * 1000;
}

function hmToTs(baseTs, hm) {
  return dayStartTs(baseTs) + parseHM(hm) * 60 * 1000;
}

function inDND(ts, prefs) {
  const cur = parseHM(bjParts(ts).hhmm);
  const s = parseHM(prefs.dndStart || STRATEGY.dndStart);
  const e = parseHM(prefs.dndEnd || STRATEGY.dndEnd);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

function nextDndEnd(ts, prefs) {
  let end = hmToTs(ts, prefs.dndEnd || STRATEGY.dndEnd);
  if (end <= ts) end += 24 * 3600 * 1000;
  return end;
}

// ---------- 行情（与小程序同一数据源） ----------

function httpsGet(url, text) {
  return new Promise((resolve, reject) => {
    const request = https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0 gold-quote-cloud" } }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error("quote-http-" + res.statusCode));
          return;
        }
        let s = "";
        res.on("data", (d) => (s += d));
        res.on("end", () => {
          if (text) return resolve(s);
          try {
            resolve(JSON.parse(s));
          } catch (e) {
            reject(e);
          }
        });
      })
      .on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("quote-timeout")));
  });
}

const OZ_TO_GRAM = 31.1034768;

/**
 * 行情快照（主品种沪金，国际金用于异动监测与简报参考）
 * 返回 { au: {price, prevClose, pct}, intl: {usd, cnyPerGram, pct} }
 */
async function getQuotes() {
  const fetch = async (secid, fields) => {
    try {
      const result = await httpsGet(`https://push2.eastmoney.com/api/qt/stock/get?secid=${secid}&fields=${fields}`);
      return result && result.data;
    } catch (e) {
      console.warn("quote-unavailable", secid, String(e.message || e.errMsg || "unknown"));
      return null;
    }
  };
  // 并行请求，行情提供方超时时整批最多等待 5 秒。
  const [au, intl, fx] = await Promise.all([
    fetch("118.AU9999", "f43,f60,f170,f124"),
    fetch("122.XAU", "f43,f60,f170,f124"),
    fetch("133.USDCNH", "f43")
  ]);
  const out = { au: null, intl: null };
  const sourceAt = q => positive(q.f124) ? q.f124 * 1000 : null;
  if (au && positive(au.f43)) {
    out.au = { price: au.f43 / 100, prevClose: positive(au.f60) ? au.f60 / 100 : null,
      pct: Number.isFinite(au.f170) ? au.f170 / 100 : null, sourceAt: sourceAt(au) };
  }
  if (intl && positive(intl.f43)) {
    const usd = intl.f43 / 100;
    const prevClose = positive(intl.f60) ? intl.f60 / 100 : null;
    const rate = fx && positive(fx.f43) ? fx.f43 / 10000 : null;
    out.intl = { usd, prevClose,
      cnyPerGram: rate > 5 && rate < 9 ? usd * rate / OZ_TO_GRAM : null,
      pct: Number.isFinite(intl.f170) ? intl.f170 / 100 : prevClose ? (usd / prevClose - 1) * 100 : null,
      sourceAt: sourceAt(intl) };
  }
  return out;
}

// ---------- 模板数据 ----------
// key 与后台模板逐字对应（公共模板的 key 编号不连续，属正常现象）：
// - 每日数据更新通知：产品名称 thing15 / 今日价格 amount5（金额类型）/ 昨日涨跌 character_string6 / 统计日期 time7
// - 涨幅变动通知：作品名称 thing2 / 基金名称 thing6 / 备注 thing10 / 更新时间 time9
function v20(s) {
  return String(s == null ? "" : s).slice(0, 20);
}

function buildData(type, meta, quotes) {
  if (isBrief(type)) {
    const au = quotes.au;
    const intl = quotes.intl;
    // 沪金优先；拉不到沪金时用国际折算元/克兜底（amount 字段不能空）
    const src =
      au && positive(au.price)
        ? au
        : intl && positive(intl.cnyPerGram)
          ? { price: intl.cnyPerGram, prevClose: null, pct: intl.pct }
          : null;
    return {
      thing15: { value: v20(au && positive(au.price) ? "沪金 Au99.99 (元/克)" : "伦敦金折算 (元/克)") },
      amount5: { value: fmtAmount(src && src.price) },
      // 昨日涨跌 = 较昨收的涨跌（即今日涨跌）；character_string 不支持中文，用 -16.20(-1.85%) 格式
      character_string6: { value: fmtChangeText(src) },
      time7: { value: fmtDateTime((au && positive(au.price) ? au : intl).sourceAt || Date.now()) }
    };
  }
  // 异动提醒（分品种，沪金/伦敦金共用「涨幅变动通知」模板）
  return {
    thing2: { value: v20(meta.title || (type === T.VOL_AU ? "沪金异动提醒" : "伦敦金异动提醒")) },
    thing6: { value: v20(meta.priceText || "") },
    thing10: { value: v20(meta.hitText || "") },
    time9: { value: meta.timeText || fmtDateTime(Date.now()) }
  };
}

function fmtPct(p) {
  return (p > 0 ? "+" : "") + Number(p).toFixed(2) + "%";
}

/** amount 金额类型：1 个币种符号 + 纯数字（可带小数），如 ¥863.00 */
function fmtAmount(v) {
  return isFinite(v) ? "¥" + Number(v).toFixed(2) : "¥0.00";
}

/** character_string 类型：仅数字/字母/符号（不能中文），如 -16.20(-1.85%) */
function fmtChangeText(q) {
  if (!q || !isFinite(q.pct)) return "--";
  const pctText = fmtPct(q.pct);
  if (!isFinite(q.price) || !isFinite(q.prevClose) || q.prevClose <= 0) return pctText;
  const diff = q.price - q.prevClose;
  return (diff > 0 ? "+" : "") + diff.toFixed(2) + "(" + pctText + ")";
}

// ---------- 任务创建（幂等） ----------

async function createTask(task) {
  const doc = Object.assign({}, task, {
    templateId: isBrief(task.type) ? TEMPLATE.dailyBrief : TEMPLATE.volatility,
    status: "pending", retryCount: 0, createdAt: Date.now()
  });
  try {
    await db.collection("sendTasks").add({ data: doc });
    return true;
  } catch (e) {
    // 只把明确重复当作幂等命中；权限、集合不存在等错误必须暴露。
    if (!/duplicate|exists|已存在|重复/i.test(String(e.errMsg || e.message || ""))) throw e;
    const old = await db.collection("sendTasks").doc(task._id).get();
    if (old.data.status === "sent" && TARGET_KEYS.includes(task.type)) {
      // 发送成功但随后自动关闭失败时，下轮扫描修复开关，不再发送。
      await disarmTarget(task);
      return false;
    }
    // 仅恢复确定未发送的任务。已发送、处理中、结果不明和失败超限不重发。
    const safe = ["expired", "no-quota", "no-auth", "cancelled"].includes(old.data.status);
    const nextDayCap = TARGET_KEYS.includes(task.type) && old.data.status === "skipped" && old.data.updatedAt < dayStartTs(Date.now());
    if (!safe && !nextDayCap) return false;
    const recovered = await db.collection("sendTasks")
      .where({ _id: task._id, status: old.data.status })
      .update({ data: { status: "pending", triggerTime: task.triggerTime, expireAt: task.expireAt, meta: task.meta, reason: "", lastError: "", retryCount: 0, updatedAt: Date.now() } });
    return !!(recovered.stats && recovered.stats.updated);
  }
}

// 分页扫描，避免云数据库默认条数使后面的用户永远收不到提醒。
async function readAll(collection, filter) {
  const rows = [];
  for (let offset = 0; ; offset += 100) {
    let query = db.collection(collection);
    if (filter) query = query.where(filter);
    const page = await query.orderBy("_id", "asc").skip(offset).limit(100).get();
    rows.push(...page.data);
    if (page.data.length < 100) return rows;
  }
}

async function scan() {
  const now = Date.now();
  const users = (await readAll("preferences")).filter(user => user.multiAssetVersion !== 1);
  // 自动关闭的补偿与当前价格无关：发送后价格回撤也能修复开关。
  for (const user of users) {
    for (const type of TARGET_KEYS.filter(key => user[key] && user[key + "RuleId"])) {
      let previous;
      try {
        previous = await db.collection("sendTasks").doc(`${type}:${user.openid}:${user[type + "RuleId"]}`).get();
      } catch (e) {
        if (!/not.?found|not.?exist|不存在/i.test(String(e.errMsg || e.message || ""))) throw e;
      }
      if (previous && previous.data.status === "sent") {
        await disarmTarget({ type, openid: user.openid, meta: { ruleId: user[type + "RuleId"] } });
        user[type] = false;
      }
    }
  }
  const needsQuotes = users.some(u => u.volatilityAu || u.volatilityXau || u.shortAu || u.shortXau || TARGET_KEYS.some(k => u[k]));
  const quotes = needsQuotes ? await getQuotes() : {};
  const needsHistory = users.some(u => u.shortAu || u.shortXau);
  let samples = [];
  if (needsHistory) {
    // 单个有界滚动文档，无需长期留存或清理不断增长的行情记录。
    const ref = db.collection("quoteSnapshots").doc("rolling");
    let snapshot;
    try { snapshot = await ref.get(); }
    catch (e) {
      if (!/not.?found|not.?exist|不存在/i.test(String(e.errMsg || e.message || ""))) throw e;
    }
    samples = ((snapshot && snapshot.data.samples) || []).filter(s => s.at >= now - 30 * 60000 && s.at < now);
    const slot = Math.floor(now / 60000);
    const sample = {
      at: now, slot,
      au: freshPrice(quotes.au, "au", now) != null ? quotes.au : null,
      intl: freshPrice(quotes.intl, "intl", now) != null ? quotes.intl : null
    };
    const payload = { data: { samples: [...samples.filter(s => s.slot !== slot), sample].slice(-32), updatedAt: now } };
    try {
      await ref.set(payload);
    } catch (e) {
      // doc.set 不会自动建集合：首次运行或新环境缺 quoteSnapshots 时自愈，避免整个 scan 失败。
      if (!/-502005|not.?exist|不存在/i.test(String(e.errMsg || e.message || ""))) throw e;
      await db.createCollection("quoteSnapshots");
      await ref.set(payload);
    }
  }
  let created = 0;
  for (const user of users) {
    for (const task of planTasks(user, quotes, samples, now)) {
      if (await createTask(task)) created++;
    }
  }
  try {
    const multi = await assetTasks.scan();
    return { ok: true, created: created + multi.created, assetCreated: multi.created };
  } catch (error) {
    console.error("asset-scan-error", error);
    return { ok: false, created, assetError: String(error.errMsg || error.message || "unknown") };
  }
}

// ---------- dispatchTimer：发送 ----------

async function dispatch() {
  const now = Date.now();
  // 进程超时可能发生在发送前或后，遗留认领只标记核查，不能自动重发。
  await db.collection("sendTasks").where({ status: "processing", updatedAt: _.lte(now - 10 * 60000) })
    .update({ data: { status: "pending-check", reason: "worker-interrupted", updatedAt: now } });
  const pending = await db.collection("sendTasks")
    .where({ status: "pending", triggerTime: _.lte(now + 5000) })
    .orderBy("triggerTime", "asc").limit(100).get();
  if (!pending.data.length) return { ok: true, processed: 0 };
  const tasks = pending.data.sort((a, b) => (b.priority || 0) - (a.priority || 0)).slice(0, 20);
  const quotes = tasks.some(t => isBrief(t.type)) ? await getQuotes() : {};
  let processed = 0;
  for (const task of tasks) {
    // 预占任务本身，重叠的定时调用不能发送同一条消息两次。
    const expected = { _id: task._id, status: "pending", triggerTime: task.triggerTime };
    if (typeof task.retryCount === "number") expected.retryCount = task.retryCount;
    const claim = await db.collection("sendTasks").where(expected)
      .update({ data: { status: "processing", updatedAt: Date.now() } });
    if (!claim.stats || !claim.stats.updated) continue;
    try {
      if (task.schemaVersion === 2) await assetTasks.handleTask(task);
      else await handleTask(task, Date.now(), quotes);
    }
    catch (error) {
      // 执行中断后结果可能不明，保留记录供核查，不盲目重发。
      console.error("reminder-task-error", task._id, error);
      await db.collection("sendTasks").where({ _id: task._id, status: "processing" }).update({ data: {
        status: "pending-check", lastError: String(error.errMsg || error.message || "unknown"), updatedAt: Date.now()
      } });
    }
    processed++;
  }
  return { ok: true, processed };
}

async function sentTodayByType(openid, now) {
  const start = dayStartTs(now);
  const rows = await readAll("sendTasks", { openid, status: "sent", sentAt: _.gte(start) });
  const counts = {};
  for (const t of rows) counts[t.type] = (counts[t.type] || 0) + 1;
  return counts;
}

async function handleTask(task, now, quotes) {
  const setTask = (patch) =>
    db.collection("sendTasks").doc(task._id).update({ data: patch });

  // 发送前核对规则版本、价格、阈值和时间，避免旧设置继续推送。
  let prefDoc;
  try { prefDoc = await db.collection("preferences").doc(task.openid).get(); }
  catch (e) {
    if (!/not.?found|not.?exist|不存在/i.test(String(e.errMsg || e.message || ""))) throw e;
  }
  const prefs = (prefDoc && prefDoc.data) || {};
  if (prefs.multiAssetVersion === 1) {
    await setTask({ status: "cancelled", reason: "migrated-to-assets", updatedAt: now });
    return;
  }
  if (!isTaskCurrent(task, prefs)) {
    await setTask({ status: "cancelled", reason: "settings-changed", updatedAt: now });
    return;
  }
  // 先检查时效，再处理免打扰；短时预警过期后不在次日补发。
  if (task.expireAt && now > task.expireAt) {
    await setTask({ status: "expired", reason: "stale-alert", updatedAt: now });
    return;
  }
  if (inDND(now, prefs)) {
    const next = nextDndEnd(now, prefs);
    if (task.expireAt && next > task.expireAt) {
      await setTask({ status: "expired", reason: "dnd-past-expiry", updatedAt: now });
    } else {
      await setTask({ status: "pending", triggerTime: next, reason: "dnd", updatedAt: now });
    }
    return;
  }
  const counts = await sentTodayByType(task.openid, now);
  if (!withinLimit(task.type, counts)) {
    await setTask({ status: "skipped", reason: "daily-cap", updatedAt: now });
    return;
  }
  // 行情失败不发送伪造的 0 元简报；时效内等待下一轮重试。
  if (isBrief(task.type) && !(quotes.au && positive(quotes.au.price)) && !(quotes.intl && positive(quotes.intl.cnyPerGram))) {
    await setTask({ status: "pending", triggerTime: now + 60000, reason: "quote-unavailable", updatedAt: now });
    return;
  }

  // 5) 原子预占额度（remaining>0 才扣）
  const reserve = await db
    .collection("subscriptions")
    .where({ openid: task.openid, templateId: task.templateId, remaining: _.gt(0) })
    .update({ data: { remaining: _.inc(-1), updatedAt: now } });
  if (!reserve.stats || reserve.stats.updated === 0) {
    await setTask({ status: "no-quota", updatedAt: now });
    return;
  }
  const refund = () =>
    db
      .collection("subscriptions")
      .where({ openid: task.openid, templateId: task.templateId })
      .update({ data: { remaining: _.inc(1), updatedAt: Date.now() } });

  // 6) 发送
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: task.openid,
      templateId: task.templateId,
      page: PAGE,
      data: buildData(task.type, task.meta || {}, quotes),
      miniprogramState: MINIPROGRAM_STATE
    });
  } catch (err) {
    const code = err && err.errCode;
    if (code === 43101 || code === 47002) {
      // 无授权资格：退回次数，提示用户在前端重新授权
      await refund();
      await setTask({ status: "no-auth", lastError: String(code), updatedAt: Date.now() });
    } else if (RETRYABLE.includes(code)) {
      // 明确的临时失败：退回次数并重试
      await refund();
      const retryCount = (task.retryCount || 0) + 1;
      if (retryCount <= STRATEGY.retryLimit) {
        await setTask({
          status: "pending",
          retryCount,
          triggerTime: Date.now() + STRATEGY.retryDelayMs,
          lastError: String(code),
          updatedAt: Date.now()
        });
      } else {
        await setTask({ status: "failed", retryCount, lastError: String(code), updatedAt: Date.now() });
      }
    } else if (typeof code === "number") {
      // 明确失败（模板数据不合法等）：退回次数，不重试
      await refund();
      await setTask({ status: "failed", lastError: String(code), updatedAt: Date.now() });
    } else {
      // 结果不明：不退回、不重发，记待核查
      await setTask({ status: "pending-check", lastError: (err && err.errMsg) || "unknown", updatedAt: Date.now() });
    }
    return;
  }
  // 发送确认成功后，持久化失败不能进入发送失败分支退还额度或重发。
  await setTask({ status: "sent", reason: "", lastError: "", sentAt: Date.now(), updatedAt: Date.now() });
  if (TARGET_KEYS.includes(task.type)) await disarmTarget(task);
}

async function disarmTarget(task) {
  await db.collection("preferences")
    .where({ _id: task.openid, [task.type + "RuleId"]: task.meta.ruleId })
    .update({ data: { [task.type]: false, updatedAt: Date.now() } });
}

// 手动测试只发送给当前调用者，且和普通异动提醒共用授权次数。
async function testNotification() {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, err: "no-openid" };
  const now = Date.now();
  const id = `test:${OPENID}:${now}:${Math.random().toString(36).slice(2)}`;
  await db.collection("sendTasks").add({ data: {
    _id: id, openid: OPENID, type: "testNotification", templateId: TEMPLATE.volatility,
    status: "processing", createdAt: now, triggerTime: now, updatedAt: now
  } });
  const set = data => db.collection("sendTasks").doc(id).update({ data: { ...data, updatedAt: Date.now() } });
  const filter = { openid: OPENID, templateId: TEMPLATE.volatility };
  const reserved = await db.collection("subscriptions").where({ ...filter, remaining: _.gt(0) })
    .update({ data: { remaining: _.inc(-1), updatedAt: now } });
  if (!reserved.stats || !reserved.stats.updated) {
    await set({ status: "no-quota" });
    return { ok: false, err: "no-quota" };
  }
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: OPENID, templateId: TEMPLATE.volatility, page: PAGE, miniprogramState: MINIPROGRAM_STATE,
      data: buildData("testNotification", { title: "通知测试", priceText: "测试消息", hitText: "通知通道测试" }, {})
    });
  } catch (error) {
    const code = error && error.errCode;
    if (typeof code === "number") {
      await db.collection("subscriptions").where(filter).update({ data: { remaining: _.inc(1), updatedAt: Date.now() } });
      await set({ status: code === 43101 ? "no-auth" : "failed", lastError: String(code) });
      return { ok: false, err: "send-failed", code };
    }
    await set({ status: "pending-check", lastError: String(error && (error.errMsg || error.message) || "unknown") });
    return { ok: false, err: "send-uncertain" };
  }
  await set({ status: "sent", sentAt: Date.now() });
  return { ok: true };
}

exports.main = async (event) => {
  if (event && event.action === "testNotification") return testNotification();
  // 云端定时器使用 TriggerName；保留小写字段以兼容已有手动测试入参。
  const triggerName = (event && (event.TriggerName || event.triggerName)) || "manual";
  if (triggerName === "scanTimer") return scan();
  if (triggerName === "dispatchTimer") {
    // 在同一轮扫描后分发，不依赖两个独立定时器的先后顺序。
    // 扫描故障也要分发已有任务；返回错误便于云端日志排查。
    let scanned;
    try { scanned = await scan(); }
    catch (error) {
      console.error("reminder-scan-error", error);
      scanned = { ok: false, scanError: String(error.errMsg || error.message || "unknown") };
    }
    const dispatched = await dispatch();
    return { ...scanned, ...dispatched, ok: scanned.ok && dispatched.ok };
  }
  // 手动空参保留仅分发行为，便于排查已排队任务。
  return dispatch();
};
