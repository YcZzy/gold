// 纯规则：不读数据库、不发消息，金额单位随品种固定。
const MINUTE = 60000;
const TARGET_KEYS = ["targetAuLow", "targetAuHigh", "targetXauLow", "targetXauHigh"];
const REGULAR_TYPES = ["dailyBrief", "scheduledBrief", "volAu", "volXau", "shortAu", "shortXau"];
const TITLES = {
  targetAuLow: "沪金跌到价提醒", targetAuHigh: "沪金涨到价提醒",
  targetXauLow: "伦敦金跌到价提醒", targetXauHigh: "伦敦金涨到价提醒",
  volAu: "沪金异动提醒", volXau: "伦敦金异动提醒",
  shortAu: "沪金短时波动", shortXau: "伦敦金短时波动"
};

function bjParts(ts) {
  const d = new Date(ts + 8 * 3600000);
  const p = n => String(n).padStart(2, "0");
  return {
    ymd: `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}`,
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    timeText: `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
  };
}

function positive(value) { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function freshPrice(quote, market, now) {
  const price = quote && quote[market === "au" ? "price" : "usd"];
  if (!positive(price) || !positive(quote.sourceAt)) return null;
  const age = now - quote.sourceAt;
  return age >= -MINUTE && age <= 10 * MINUTE ? price : null;
}
function threshold(value, fallback) {
  return [0.5, 1, 1.5, 2, 3, 5].includes(value) ? value : fallback;
}
function isBrief(type) { return type === "dailyBrief" || type === "scheduledBrief"; }
function targetMarket(type) { return type.startsWith("targetAu") ? "au" : "intl"; }
function priceText(market, price) { return `${market === "au" ? "沪金" : "伦敦金"} ${price.toFixed(2)}`; }

function shortMove(market, quotes, samples, now) {
  const current = quotes[market];
  const price = freshPrice(current, market, now);
  if (price == null) return null;
  const baseline = samples.filter(s => Math.abs(now - s.at - 15 * MINUTE) <= 3 * MINUTE)
    .sort((a, b) => Math.abs(now - a.at - 15 * MINUTE) - Math.abs(now - b.at - 15 * MINUTE))
    .find(s => {
      const q = s[market];
      return freshPrice(q, market, s.at) != null &&
        current.sourceAt - q.sourceAt >= 12 * MINUTE && current.sourceAt - q.sourceAt <= 18 * MINUTE;
    });
  if (!baseline) return null;
  const previous = freshPrice(baseline[market], market, baseline.at);
  return { price, pct: (price / previous - 1) * 100 };
}

function planTasks(prefs, quotes = {}, samples = [], now) {
  const p = bjParts(now);
  const tasks = [];
  const dayStart = now - (p.minutes * MINUTE + now % MINUTE);
  const add = (type, suffix, meta, triggerTime = now, expireAt = now + 30 * MINUTE, date = p.ymd) => {
    tasks.push({
      _id: `${suffix}:${prefs.openid}:${TARGET_KEYS.includes(type) ? meta.ruleId : date}`,
      openid: prefs.openid, type, triggerTime, expireAt,
      priority: TARGET_KEYS.includes(type) ? 1 : 0,
      meta: { title: TITLES[type] || "金价行情更新", timeText: p.timeText, ...meta }
    });
  };
  const weekday = p.weekday >= 1 && p.weekday <= 5;
  if (prefs.dailyBrief && weekday && p.minutes >= 15 * 60 + 30 && p.minutes <= 15 * 60 + 55) {
    add("dailyBrief", "brief", {}, Math.max(dayStart + (15 * 60 + 40) * MINUTE, now), dayStart + 24 * 60 * MINUTE - 1);
  }
  const time = prefs.scheduledTime || "09:00";
  const [h, m] = time.split(":").map(Number);
  // 任意分钟可跨午夜落在下一次扫描；按应播日期判断工作日和去重。
  const todayDue = dayStart + (h * 60 + m) * MINUTE;
  const due = todayDue <= now ? todayDue : todayDue - 24 * 60 * MINUTE;
  const scheduledDay = bjParts(due);
  const scheduledWeekday = scheduledDay.weekday >= 1 && scheduledDay.weekday <= 5;
  if (prefs.scheduledBrief && (prefs.scheduledWeekdaysOnly === false || scheduledWeekday) && now - due < 6 * MINUTE) {
    add("scheduledBrief", "scheduledBrief", { scheduledTime: time, scheduledWeekdaysOnly: prefs.scheduledWeekdaysOnly !== false }, now, now + 30 * MINUTE, scheduledDay.ymd);
  }
  for (const key of TARGET_KEYS) {
    const market = targetMarket(key);
    const price = freshPrice(quotes[market], market, now);
    const targetPrice = prefs[key + "Price"];
    const ruleId = prefs[key + "RuleId"];
    if (!prefs[key] || !positive(targetPrice) || !ruleId || price == null) continue;
    if (key.endsWith("Low") ? price <= targetPrice : price >= targetPrice) {
      add(key, key, { ruleId, targetPrice, priceText: priceText(market, price), hitText: `${key.endsWith("Low") ? "跌至" : "涨至"}目标 ${targetPrice.toFixed(2)}` });
    }
  }
  const dailyThreshold = threshold(prefs.volatilityPct, 1.5);
  const shortThreshold = threshold(prefs.shortPct, 1);
  for (const [market, switchKey, type, shortType] of [["au", "volatilityAu", "volAu", "shortAu"], ["intl", "volatilityXau", "volXau", "shortXau"]]) {
    const q = quotes[market];
    const price = freshPrice(q, market, now);
    if (prefs[switchKey] && price != null && Number.isFinite(q.pct) && Math.abs(q.pct) >= dailyThreshold) {
      add(type, type, { threshold: dailyThreshold, priceText: priceText(market, price), hitText: `较昨收${q.pct > 0 ? "+" : ""}${q.pct.toFixed(2)}%` });
    }
    if (prefs[shortType]) {
      const move = shortMove(market, quotes, samples, now);
      if (move && Math.abs(move.pct) >= shortThreshold) {
        add(shortType, shortType, { threshold: shortThreshold, priceText: priceText(market, move.price), hitText: `约15分钟${move.pct > 0 ? "+" : ""}${move.pct.toFixed(2)}%` }, now, now + 15 * MINUTE);
      }
    }
  }
  return tasks;
}

function isTaskCurrent(task, prefs) {
  const meta = task.meta || {};
  if (TARGET_KEYS.includes(task.type)) {
    return !!prefs[task.type] && prefs[task.type + "RuleId"] === meta.ruleId && prefs[task.type + "Price"] === meta.targetPrice;
  }
  if (task.type === "scheduledBrief") {
    return !!prefs.scheduledBrief && (prefs.scheduledTime || "09:00") === meta.scheduledTime &&
      (prefs.scheduledWeekdaysOnly !== false) === meta.scheduledWeekdaysOnly;
  }
  if (task.type === "dailyBrief") return !!prefs.dailyBrief;
  if (task.type === "volAu" || task.type === "volXau") {
    return !!prefs[task.type === "volAu" ? "volatilityAu" : "volatilityXau"] && threshold(prefs.volatilityPct, 1.5) === (meta.threshold || 1.5);
  }
  if (task.type === "shortAu" || task.type === "shortXau") return !!prefs[task.type] && threshold(prefs.shortPct, 1) === meta.threshold;
  return false;
}

function withinLimit(type, counts) {
  if (TARGET_KEYS.includes(type)) return (counts[type] || 0) < 1;
  if (!REGULAR_TYPES.includes(type)) return false;
  return (counts[type] || 0) < 1 && REGULAR_TYPES.reduce((sum, key) => sum + (counts[key] || 0), 0) < 6;
}

module.exports = { planTasks, isTaskCurrent, withinLimit, freshPrice, isBrief, positive, TARGET_KEYS, REGULAR_TYPES };
