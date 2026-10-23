/**
 * 提醒任务处理（定时触发器驱动，关掉小程序也能跑）
 *
 * 触发器（config.json）：
 * - dispatchTimer：每分钟扫描到期任务并发送
 * - scanTimer：每 5 分钟拉取价格，生成简报/异动任务（异动分沪金/伦敦金两个品种）
 *
 * 发送链路（对应文档约定）：
 * 检查提醒开关 → 免打扰 → 剩余次数 → 任务有效期 → 原子预占额度 →
 * cloud.openapi.subscribeMessage.send → 成功扣次数 / 明确失败退回并按错误类型重试 /
 * 结果不明记 pending-check 不盲目重发 / 无授权资格记 no-auth
 *
 * 幂等：任务 _id 唯一（brief/volAu/volXau + openid + 日期），预占额度用条件 update 原子扣减。
 */
const https = require("https");
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const T = {
  BRIEF: "dailyBrief",
  VOL_AU: "volAu",
  VOL_XAU: "volXau"
};

// 订阅消息模板 ID（与 utils/app-config.js 保持一致；沪金/伦敦金异动共用 volatility 模板）
const TEMPLATE = {
  dailyBrief: "Wn6LX6JivcT9MkSoM81zR2uvcSFOEx3IuFLT5QXEVhw", // 每日数据更新通知
  volatility: "mQZ8fr72Xbf5nMlEjhP1ie9gl-2ndoeZa8_8upWsDYs" // 涨幅变动通知
};

const PAGE = "pages/index/index";
const MINIPROGRAM_STATE = "formal"; // 开发版联调时可临时改 "developer"

const STRATEGY = {
  briefTime: "15:40",
  briefWindowStart: "15:30",
  briefWindowEnd: "15:55",
  briefDays: [1, 2, 3, 4, 5], // 周一至周五（UTC+8）
  maxPerDay: 3, // 简报 1 + 沪金异动 1 + 伦敦金异动 1
  maxBriefPerDay: 1,
  maxVolPerDay: 1, // 每个品种各 1 条/日
  volatilityPct: 1.5,
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
    https
      .get(url, { headers: { "User-Agent": "Mozilla/5.0 gold-quote-cloud" } }, (res) => {
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
  });
}

const OZ_TO_GRAM = 31.1034768;

/**
 * 行情快照（主品种沪金，国际金用于异动监测与简报参考）
 * 返回 { au: {price, prevClose, pct}, intl: {usd, cnyPerGram, pct} }
 */
async function getQuotes() {
  const out = { au: null, intl: null };
  try {
    const d = await httpsGet(
      "https://push2.eastmoney.com/api/qt/stock/get?secid=118.AU9999&fields=f43,f60,f170"
    );
    const q = d && d.data;
    if (q && q.f43) {
      out.au = { price: q.f43 / 100, prevClose: q.f60 / 100, pct: q.f170 / 100 };
    }
  } catch (e) {
    /* 沪金行情失败 */
  }
  // 伦敦金：东财 122.XAU（现价/昨收/涨跌幅自带）+ 汇率 133.USDCNH 折算元/克
  try {
    const d = await httpsGet(
      "https://push2.eastmoney.com/api/qt/stock/get?secid=122.XAU&fields=f43,f60,f170"
    );
    const q = d && d.data;
    if (q && q.f43) {
      const usd = q.f43 / 100;
      const prevClose = q.f60 ? q.f60 / 100 : null;
      let rate = null;
      try {
        const fx = await httpsGet(
          "https://push2.eastmoney.com/api/qt/stock/get?secid=133.USDCNH&fields=f43"
        );
        const fd = fx && fx.data;
        const r = fd && fd.f43 ? fd.f43 / 10000 : null;
        if (r > 5 && r < 9) rate = r;
      } catch (e) {
        /* 汇率可选 */
      }
      out.intl = {
        usd,
        cnyPerGram: rate ? (usd * rate) / OZ_TO_GRAM : null,
        prevClose,
        pct: q.f170 != null ? q.f170 / 100 : prevClose ? ((usd - prevClose) / prevClose) * 100 : null
      };
    }
  } catch (e) {
    /* 国际行情失败 */
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
  if (type === T.BRIEF) {
    const au = quotes.au;
    const intl = quotes.intl;
    // 沪金优先；拉不到沪金时用国际折算元/克兜底（amount 字段不能空）
    const src =
      au && isFinite(au.price)
        ? au
        : intl && isFinite(intl.cnyPerGram)
          ? { price: intl.cnyPerGram, prevClose: null, pct: intl.pct }
          : null;
    return {
      thing15: { value: v20("沪金 Au99.99 (元/克)") },
      amount5: { value: fmtAmount(src && src.price) },
      // 昨日涨跌 = 较昨收的涨跌（即今日涨跌）；character_string 不支持中文，用 -16.20(-1.85%) 格式
      character_string6: { value: fmtChangeText(src) },
      time7: { value: fmtDateTime(Date.now()) }
    };
  }
  // 异动提醒（分品种，沪金/伦敦金共用「涨幅变动通知」模板）
  return {
    thing2: { value: v20(type === T.VOL_AU ? "沪金异动提醒" : "伦敦金异动提醒") },
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

/** 涨跌额（带符号），拿不到昨收返回 -- */
function fmtDiff(price, prevClose) {
  if (!isFinite(price) || !isFinite(prevClose) || prevClose <= 0) return "--";
  const diff = price - prevClose;
  return (diff > 0 ? "+" : "") + diff.toFixed(2);
}

// ---------- 任务创建（幂等） ----------

async function createTask(taskId, doc) {
  try {
    await db.collection("sendTasks").add({
      data: Object.assign({ _id: taskId }, doc, {
        status: "pending",
        retryCount: 0,
        createdAt: Date.now()
      })
    });
    return true;
  } catch (e) {
    return false; // 已存在（重复扫描）
  }
}

// ---------- scanTimer：生成任务 ----------

async function scan() {
  const now = Date.now();
  const part = bjParts(now);
  const created = [];

  // 1) 每日简报：工作日 15:30-15:55 窗口内生成一次
  if (STRATEGY.briefDays.includes(part.weekday) && part.hhmm >= STRATEGY.briefWindowStart && part.hhmm <= STRATEGY.briefWindowEnd) {
    const users = await db.collection("preferences").where({ dailyBrief: true }).get();
    for (const u of users.data) {
      const ok = await createTask(`brief:${u.openid}:${part.ymd}`, {
        openid: u.openid,
        type: T.BRIEF,
        templateId: TEMPLATE[T.BRIEF],
        triggerTime: Math.max(hmToTs(now, STRATEGY.briefTime), now + 15 * 1000),
        meta: {}
      });
      if (ok) created.push(u.openid);
    }
  }

  // 2) 波动异动（分品种：沪金 / 伦敦金），同品种同方向当日一次
  const alerts = await db
    .collection("preferences")
    .where(_.or([{ volatilityAu: true }, { volatilityXau: true }]))
    .get();
  if (!alerts.data.length) return { ok: true, created: created.length };

  const quotes = await getQuotes();
  for (const u of alerts.data) {
    const pref = u;
    if (
      pref.volatilityAu &&
      quotes.au &&
      quotes.au.pct != null &&
      Math.abs(quotes.au.pct) >= STRATEGY.volatilityPct
    ) {
      const dir = quotes.au.pct > 0 ? "up" : "down";
      await createTask(`volAu:${u.openid}:${part.ymd}:${dir}`, {
        openid: u.openid,
        type: T.VOL_AU,
        templateId: TEMPLATE.volatility,
        triggerTime: now + 15 * 1000,
        meta: {
          // thing6（基金名称）：品种 + 现价 + 今日涨跌幅
          priceText: v20(`沪金 ${quotes.au.price.toFixed(2)} ${fmtPct(quotes.au.pct)}`),
          // thing10（备注）：涨跌额 + 方向
          hitText: v20(`较昨收${fmtDiff(quotes.au.price, quotes.au.prevClose)} ${dir === "up" ? "快速拉升" : "快速回落"}`),
          timeText: fmtDateTime(now)
        }
      });
    }
    if (
      pref.volatilityXau &&
      quotes.intl &&
      quotes.intl.pct != null &&
      Math.abs(quotes.intl.pct) >= STRATEGY.volatilityPct
    ) {
      const dir = quotes.intl.pct > 0 ? "up" : "down";
      await createTask(`volXau:${u.openid}:${part.ymd}:${dir}`, {
        openid: u.openid,
        type: T.VOL_XAU,
        templateId: TEMPLATE.volatility,
        triggerTime: now + 15 * 1000,
        meta: {
          // thing6（基金名称）：品种 + 现价（美元/盎司）+ 今日涨跌幅
          priceText: v20(`伦敦金 ${quotes.intl.usd.toFixed(2)} ${fmtPct(quotes.intl.pct)}`),
          // thing10（备注）：涨跌额 + 方向
          hitText: v20(`较昨收${fmtDiff(quotes.intl.usd, quotes.intl.prevClose)} ${dir === "up" ? "快速拉升" : "快速回落"}`),
          timeText: fmtDateTime(now)
        }
      });
    }
  }
  return { ok: true, created: created.length };
}

// ---------- dispatchTimer：发送 ----------

async function dispatch() {
  const now = Date.now();
  const pending = await db
    .collection("sendTasks")
    .where({ status: "pending", triggerTime: _.lte(now + 5 * 1000) })
    .orderBy("triggerTime", "asc")
    .limit(20)
    .get();
  if (!pending.data.length) return { ok: true, processed: 0 };

  const quotes = await getQuotes(); // 每批取一次价，简报用最新值
  let processed = 0;
  for (const task of pending.data) {
    await handleTask(task, now, quotes);
    processed++;
  }
  return { ok: true, processed };
}

function prefSwitchOn(type, prefs) {
  if (type === T.BRIEF) return !!prefs.dailyBrief;
  if (type === T.VOL_AU) return !!prefs.volatilityAu;
  return !!prefs.volatilityXau;
}

async function sentTodayByType(openid, now) {
  const start = dayStartTs(now);
  const res = await db
    .collection("sendTasks")
    .where({ openid, status: "sent", sentAt: _.gte(start) })
    .get();
  const counts = {};
  for (const t of res.data) counts[t.type] = (counts[t.type] || 0) + 1;
  return counts;
}

async function handleTask(task, now, quotes) {
  const setTask = (patch) =>
    db.collection("sendTasks").doc(task._id).update({ data: patch });

  // 1) 提醒开关
  const prefDoc = await db.collection("preferences").doc(task.openid).get().catch(() => null);
  const prefs = (prefDoc && prefDoc.data) || {};
  if (!prefSwitchOn(task.type, prefs)) {
    await setTask({ status: "cancelled", reason: "switch-off", updatedAt: now });
    return;
  }

  // 2) 免打扰：顺延到免打扰结束（合并到早间一条不丢任务）
  if (inDND(now, prefs)) {
    await setTask({ triggerTime: nextDndEnd(now, prefs), updatedAt: now });
    return;
  }

  // 3) 任务有效期
  if (task.expireAt && now > task.expireAt) {
    await setTask({ status: "expired", updatedAt: now });
    return;
  }

  // 4) 每日次数上限
  const counts = await sentTodayByType(task.openid, now);
  const total = (counts[T.BRIEF] || 0) + (counts[T.VOL_AU] || 0) + (counts[T.VOL_XAU] || 0);
  const dailyCap = STRATEGY.maxPerDay;
  const typeCap = {
    [T.BRIEF]: STRATEGY.maxBriefPerDay,
    [T.VOL_AU]: STRATEGY.maxVolPerDay,
    [T.VOL_XAU]: STRATEGY.maxVolPerDay
  }[task.type];
  if (total >= dailyCap || (counts[task.type] || 0) >= typeCap) {
    await setTask({ status: "skipped", reason: "daily-cap", updatedAt: now });
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
    await setTask({ status: "sent", sentAt: Date.now(), updatedAt: Date.now() });
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
  }
}

exports.main = async (event) => {
  const triggerName = (event && event.triggerName) || "manual";
  if (triggerName === "scanTimer") return scan();
  return dispatch();
};
