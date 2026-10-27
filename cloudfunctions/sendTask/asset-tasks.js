// 多标的提醒：独立于旧黄金规则，保留旧用户的发送与授权账本。
const MINUTE = 60000;
const TARGETS = ["priceAbove", "priceBelow"];
const TYPES = ["priceAbove", "priceBelow", "dailyMove", "rapidMove", "scheduled", "close"];
const LABELS = { priceAbove: "涨到价", priceBelow: "跌到价", dailyMove: "日内波动", rapidMove: "短时急变", scheduled: "定时播报", close: "收盘简报" };
const positive = n => typeof n === "number" && Number.isFinite(n) && n > 0;
const take20 = text => Array.from(String(text || "")).slice(0, 20).join("");
const target = type => TARGETS.includes(type);
const brief = type => type === "scheduled" || type === "close";

function parts(ts) {
  const date = new Date(ts + 8 * 3600000);
  const pad = n => String(n).padStart(2, "0");
  return {
    ymd: `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`,
    weekday: date.getUTCDay(), minutes: date.getUTCHours() * 60 + date.getUTCMinutes(),
    text: `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  };
}
function dayStart(ts) { const p = parts(ts); return ts - p.minutes * MINUTE - ts % MINUTE; }
function validQuote(quote, asset, now) {
  return !!quote && quote.assetId === asset.id && positive(quote.price) && positive(quote.sourceTime) &&
    quote.sourceTime <= now + MINUTE && positive(quote.fetchedAt) && quote.fetchedAt <= now + MINUTE &&
    now - quote.fetchedAt <= 10 * MINUTE && !quote.stale;
}
function fresh(quote, asset, now) { return validQuote(quote, asset, now) && now - quote.sourceTime <= 10 * MINUTE; }

function planRuleTask(rule, asset, quote, samples, now, openid) {
  if (!rule || !rule.enabled || !TYPES.includes(rule.type) || rule.assetId !== asset.id || !validQuote(quote, asset, now)) return null;
  const p = parts(now);
  let date = p.ymd, reason = "", expiry = now + 30 * MINUTE;
  const pct = value => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
  if (target(rule.type)) {
    if (!positive(rule.value) || !fresh(quote, asset, now)) return null;
    if (rule.type === "priceAbove" ? quote.price < rule.value : quote.price > rule.value) return null;
    reason = `${LABELS[rule.type]} ${rule.value.toFixed(asset.precision || 2)}`;
  } else if (rule.type === "dailyMove") {
    if (!fresh(quote, asset, now) || !positive(rule.value) || !Number.isFinite(quote.changePct) || Math.abs(quote.changePct) < rule.value) return null;
    reason = `较昨收${pct(quote.changePct)}`;
  } else if (rule.type === "rapidMove") {
    if (!fresh(quote, asset, now) || !positive(rule.value)) return null;
    const previous = (samples || []).filter(s => s.assetId === asset.id && s.source === quote.source &&
      Math.abs(now - s.at - 15 * MINUTE) <= 3 * MINUTE && positive(s.price) &&
      quote.sourceTime - s.sourceTime >= 12 * MINUTE && quote.sourceTime - s.sourceTime <= 18 * MINUTE)
      .sort((a, b) => Math.abs(now - a.at - 15 * MINUTE) - Math.abs(now - b.at - 15 * MINUTE))[0];
    if (!previous) return null;
    const change = (quote.price / previous.price - 1) * 100;
    if (Math.abs(change) < rule.value) return null;
    reason = `约15分钟${pct(change)}`;
    expiry = now + 15 * MINUTE;
  } else if (rule.type === "scheduled") {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(rule.time || "")) return null;
    const [h, m] = rule.time.split(":").map(Number);
    let due = dayStart(now) + (h * 60 + m) * MINUTE;
    if (due > now) due -= 24 * 60 * MINUTE;
    const scheduledDay = parts(due);
    if (now - due >= 6 * MINUTE || (rule.weekdaysOnly !== false && [0, 6].includes(scheduledDay.weekday))) return null;
    date = scheduledDay.ymd;
    reason = "定时行情播报";
  } else {
    if (asset.id === "gold-xauusd" || [0, 6].includes(p.weekday)) return null;
    const gold = asset.id === "gold-au9999";
    const due = gold ? 15 * 60 + 40 : 15 * 60 + 10;
    const source = parts(quote.sourceTime);
    if (p.minutes < due || p.minutes > due + 45 || source.ymd !== p.ymd || source.minutes < (gold ? 15 * 60 + 30 : 15 * 60)) return null;
    reason = "收盘行情简报";
  }
  return {
    _id: `v2:${rule.id}:${target(rule.type) ? rule.version : date}`,
    schemaVersion: 2, openid, type: rule.type, assetId: asset.id, assetName: asset.name,
    ruleId: rule.id, ruleVersion: rule.version, priority: target(rule.type) ? 1 : 0,
    triggerTime: now, expireAt: expiry, createdAt: now,
    meta: { asset, quote, reason }
  };
}

function buildMessage(task) {
  const { asset, quote, reason } = task.meta;
  const price = quote.price.toFixed(asset.precision || 2);
  if (brief(task.type)) {
    return {
      thing15: { value: take20(`${asset.name} ${asset.unit}`) },
      amount5: { value: `${asset.currency === "USD" ? "$" : "¥"}${price}` },
      character_string6: { value: Number.isFinite(quote.changePct) ? `${quote.changePct > 0 ? "+" : ""}${quote.changePct.toFixed(2)}%` : "--" },
      time7: { value: parts(quote.sourceTime).text }
    };
  }
  return {
    thing2: { value: take20(`${asset.name}·${LABELS[task.type]}`) },
    thing6: { value: take20(`${price} ${asset.unit}`) },
    thing10: { value: take20(reason) },
    time9: { value: parts(quote.sourceTime).text }
  };
}

async function maybe(doc) {
  try { return (await doc.get()).data; }
  catch (error) {
    if (error.code === "DOCUMENT_NOT_FOUND" || /document.*(?:does not exist|not found|not exist)/i.test(String(error.errMsg || error.message))) return null;
    throw error;
  }
}
function currentRule(portfolio, task) {
  return portfolio && (portfolio.items || []).includes(task.assetId) && (portfolio.rules || []).find(rule =>
    rule.id === task.ruleId && rule.version === task.ruleVersion && rule.assetId === task.assetId && rule.enabled && rule.type === task.type);
}
const LEGACY = {
  dailyBrief: ["gold-au9999", "close"], scheduledBrief: ["gold-au9999", "scheduled"],
  volAu: ["gold-au9999", "dailyMove"], volXau: ["gold-xauusd", "dailyMove"],
  shortAu: ["gold-au9999", "rapidMove"], shortXau: ["gold-xauusd", "rapidMove"],
  targetAuLow: ["gold-au9999", "priceBelow"], targetAuHigh: ["gold-au9999", "priceAbove"],
  targetXauLow: ["gold-xauusd", "priceBelow"], targetXauHigh: ["gold-xauusd", "priceAbove"]
};

function createAssetTasks({ db, cloud, templates, now = Date.now }) {
  const _ = db.command;
  async function all(name, filter) {
    const rows = [];
    for (let offset = 0; ; offset += 100) {
      let query = db.collection(name);
      if (filter) query = query.where(filter);
      const page = await query.orderBy("_id", "asc").skip(offset).limit(100).get();
      rows.push(...page.data);
      if (page.data.length < 100) return rows;
    }
  }
  const patchTask = (task, patch) => db.collection("sendTasks").doc(task._id).update({ data: { ...patch, updatedAt: now() } });
  async function consume(task) {
    if (!target(task.type)) return;
    await db.runTransaction(async tx => {
      const ref = tx.collection("portfolios").doc(task.openid);
      const portfolio = await maybe(ref);
      const rule = currentRule(portfolio, task);
      if (!rule) return;
      rule.enabled = false;
      rule.updatedAt = now();
      delete portfolio._id;
      portfolio.revision = (portfolio.revision || 0) + 1;
      portfolio.updatedAt = now();
      await ref.set({ data: portfolio });
    });
  }
  async function create(task) {
    const data = { ...task, templateId: brief(task.type) ? templates.dailyBrief : templates.volatility, status: "pending", retryCount: 0 };
    try { await db.collection("sendTasks").add({ data }); return true; }
    catch (error) {
      if (!/duplicate|exists|重复|已存在/i.test(String(error.errMsg || error.message))) throw error;
      const old = await maybe(db.collection("sendTasks").doc(task._id));
      if (!old) throw error;
      if (old.status === "sent") { await consume(old); return false; }
      const safe = ["cancelled", "expired", "no-quota", "no-auth"].includes(old.status) ||
        (old.status === "skipped" && old.updatedAt < dayStart(now()));
      if (!safe) return false;
      // 匹配读取版本，避免旧扫描覆盖另一个扫描已恢复的任务。
      const filter = { _id: old._id, status: old.status };
      if (old.updatedAt != null) filter.updatedAt = old.updatedAt;
      const patch = { ...data };
      delete patch._id;
      const result = await db.collection("sendTasks").where(filter).update({ data: patch });
      return !!(result.stats && result.stats.updated);
    }
  }
  async function scan() {
    const portfolios = (await all("portfolios")).filter(p => p.migrationVersion === 1);
    const enabled = [];
    for (const p of portfolios) for (const rule of p.rules || []) {
      if (!rule.enabled || !(p.items || []).includes(rule.assetId)) continue;
      if (target(rule.type)) {
        const sent = await maybe(db.collection("sendTasks").doc(`v2:${rule.id}:${rule.version}`));
        if (sent && sent.status === "sent") { await consume(sent); continue; }
      }
      enabled.push({ portfolio: p, rule });
    }
    const ids = [...new Set(enabled.map(item => item.rule.assetId))];
    const assets = new Map(), quotes = new Map();
    // 每次调用最多 30 个去重标的，避免按用户重复请求同一只股票。
    for (let offset = 0; offset < ids.length; offset += 30) {
      const response = await cloud.callFunction({ name: "marketData", data: { action: "quotes", assetIds: ids.slice(offset, offset + 30) } });
      if (!response.result || !response.result.ok) throw new Error(response.result && response.result.hint || "行情服务不可用");
      for (const asset of response.result.assets || []) assets.set(asset.id, asset);
      for (const quote of response.result.quotes || []) quotes.set(quote.assetId, quote);
    }
    const history = new Map();
    for (const id of new Set(enabled.filter(item => item.rule.type === "rapidMove").map(item => item.rule.assetId))) {
      const ref = db.collection("quoteSnapshots").doc("asset:" + id);
      const saved = await maybe(ref);
      const samples = (saved && saved.samples || []).filter(s => s.at >= now() - 30 * MINUTE && s.at < now());
      history.set(id, samples);
      const quote = quotes.get(id), asset = assets.get(id);
      if (asset && fresh(quote, asset, now())) {
        const slot = Math.floor(now() / MINUTE);
        const data = [...samples.filter(s => s.slot !== slot), { ...quote, at: now(), slot }].slice(-32);
        await ref.set({ data: { samples: data, updatedAt: now() } });
      }
    }
    let created = 0;
    for (const { portfolio, rule } of enabled) {
      const asset = assets.get(rule.assetId);
      if (!asset) continue;
      const task = planRuleTask(rule, asset, quotes.get(rule.assetId), history.get(rule.assetId), now(), portfolio.openid || portfolio._id);
      if (task && await create(task)) created++;
    }
    return { ok: true, created };
  }
  async function seedBudget(openid, time) {
    const budget = { regular: 0, targets: 0, counts: {}, reservations: {} };
    const start = dayStart(time);
    const confirmed = await all("sendTasks", { openid, status: "sent", sentAt: _.gte(start) });
    const uncertain = [];
    for (const status of ["processing", "pending-check"]) {
      for (const task of await all("sendTasks", { openid, status })) {
        // 新版正在预占的当前任务由事务计数；旧版不明结果保守占用今天名额。
        if (task.schemaVersion !== 2 && (task.updatedAt || task.createdAt || 0) >= start) uncertain.push(task);
      }
    }
    for (const task of [...confirmed, ...uncertain]) {
      const mapped = task.schemaVersion === 2 ? [task.assetId, task.type] : LEGACY[task.type];
      if (!mapped) continue;
      const [assetId, type] = mapped;
      const key = assetId + "_" + type;
      budget.counts[key] = (budget.counts[key] || 0) + 1;
      budget[target(type) ? "targets" : "regular"]++;
    }
    return budget;
  }
  async function reserve(task) {
    const time = now(), budgetId = task.openid + ":" + parts(time).ymd;
    const initial = await seedBudget(task.openid, time);
    const templateId = brief(task.type) ? templates.dailyBrief : templates.volatility;
    const quotaId = task.openid + ":" + templateId;
    return db.runTransaction(async tx => {
      const portfolio = await maybe(tx.collection("portfolios").doc(task.openid));
      if (!currentRule(portfolio, task)) return { reason: "settings-changed" };
      const ref = tx.collection("sendBudgets").doc(budgetId);
      // SDK 遇到冲突会重放回调；种子及其嵌套表必须在每次回调内复制。
      const budget = await maybe(ref) || { ...initial, counts: { ...initial.counts }, reservations: { ...initial.reservations } };
      const quotaRef = tx.collection("subscriptions").doc(quotaId);
      const quota = await maybe(quotaRef);
      const group = target(task.type) ? "targets" : "regular", key = task.assetId + "_" + task.type;
      budget.counts ||= {};
      budget.reservations ||= {};
      if (budget.reservations[task._id]) return { reason: "pending-check" };
      if ((budget[group] || 0) >= (group === "targets" ? 4 : 6) || (budget.counts[key] || 0) >= 1) return { reason: "daily-cap" };
      if (!quota || !Number.isInteger(quota.remaining) || quota.remaining <= 0) return { reason: "no-quota" };
      delete budget._id;
      budget[group] = (budget[group] || 0) + 1;
      budget.counts[key] = (budget.counts[key] || 0) + 1;
      budget.reservations[task._id] = { key, group };
      budget.updatedAt = time;
      await ref.set({ data: budget });
      await quotaRef.update({ data: { remaining: quota.remaining - 1, updatedAt: time } });
      return { ok: true, budgetId, quotaId, templateId };
    });
  }
  async function refund(task, reservation) {
    await db.runTransaction(async tx => {
      const budgetRef = tx.collection("sendBudgets").doc(reservation.budgetId);
      const quotaRef = tx.collection("subscriptions").doc(reservation.quotaId);
      const budget = await maybe(budgetRef), quota = await maybe(quotaRef);
      const hold = budget && budget.reservations && budget.reservations[task._id];
      if (!hold) return;
      delete budget._id;
      budget[hold.group] = Math.max(0, budget[hold.group] - 1);
      budget.counts[hold.key] = Math.max(0, budget.counts[hold.key] - 1);
      delete budget.reservations[task._id];
      budget.updatedAt = now();
      await budgetRef.set({ data: budget });
      if (quota) await quotaRef.update({ data: { remaining: quota.remaining + 1, updatedAt: now() } });
    });
  }
  async function handleTask(task) {
    const time = now();
    const portfolio = await maybe(db.collection("portfolios").doc(task.openid));
    if (!currentRule(portfolio, task)) return patchTask(task, { status: "cancelled", reason: "settings-changed" });
    if (task.expireAt < time) return patchTask(task, { status: "expired", reason: "stale-alert" });
    const prefs = await maybe(db.collection("preferences").doc(task.openid)) || {};
    const minutes = parts(time).minutes;
    const hm = value => Number(value.split(":")[0]) * 60 + Number(value.split(":")[1]);
    const start = hm(prefs.dndStart || "23:00"), end = hm(prefs.dndEnd || "07:30");
    if (start !== end && (start < end ? minutes >= start && minutes < end : minutes >= start || minutes < end)) {
      let next = dayStart(time) + end * MINUTE;
      if (next <= time) next += 24 * 60 * MINUTE;
      return patchTask(task, next > task.expireAt ? { status: "expired", reason: "dnd-past-expiry" } : { status: "pending", triggerTime: next, reason: "dnd" });
    }
    const reservation = await reserve(task);
    if (!reservation.ok) {
      const statuses = { "settings-changed": "cancelled", "daily-cap": "skipped", "pending-check": "pending-check", "no-quota": "no-quota" };
      return patchTask(task, { status: statuses[reservation.reason], reason: reservation.reason });
    }
    try {
      await cloud.openapi.subscribeMessage.send({ touser: task.openid, templateId: reservation.templateId,
        page: "pages/detail/detail?assetId=" + encodeURIComponent(task.assetId), data: buildMessage(task), miniprogramState: "formal" });
    } catch (error) {
      const raw = error.errCode;
      const code = raw !== undefined && raw !== null && raw !== "" && Number.isFinite(Number(raw)) ? Number(raw) : null;
      if (code !== null) {
        await refund(task, reservation);
        if (code === 43101 || code === 47002) return patchTask(task, { status: "no-auth", lastError: String(code) });
        if ([-1, 45009].includes(code) && (task.retryCount || 0) < 3) return patchTask(task, {
          status: "pending", retryCount: (task.retryCount || 0) + 1, triggerTime: now() + 5 * MINUTE, lastError: String(code)
        });
        return patchTask(task, { status: "failed", lastError: String(code) });
      }
      return patchTask(task, { status: "pending-check", lastError: error.errMsg || error.message || "unknown" });
    }
    // 确认成功后的数据库错误由外层记录，不退还额度、不重复发送。
    await patchTask(task, { status: "sent", sentAt: now(), reason: "", lastError: "" });
    await consume(task);
  }
  return { scan, handleTask };
}
module.exports = { createAssetTasks, planRuleTask, buildMessage, fresh, currentRule };
