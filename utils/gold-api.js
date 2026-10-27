/**
 * 金价数据源封装（已实测 2026-10-23，全量收敛到东方财富）
 *
 * 全部数据来自东财，后台需配置的 request 合法域名（均有 ICP 备案，可加白）：
 *   - https://push2his.eastmoney.com   分时 / K 线（必须，本地黄金报价优先使用分时末点）
 *   - https://push2.eastmoney.com      报价备选 / 汇率
 *   （push2delay.eastmoney.com 仅降级镜像，开发期用，正式可不配）
 *
 *   - 沪金 Au99.99：secid=118.AU9999，价格字段单位「分」需 ÷100
 *   - 伦敦金现：secid=122.XAU（黄金/美元），÷100
 *   - 美元汇率：secid=133.USDCNH（离岸），÷10000；降级 120.USDCNYC（中间价），÷10000
 *   - K 线 klines[] 每项 "日期,开,收,高,低,量"
 *   - 分时 trends2 自带均价；preClose 缺失时用日 K 前收盘兜底
 *
 * 免费公开接口无 SLA。开发期请在开发者工具「详情-本地设置」勾选「不校验合法域名」。
 */

const EM_HOSTS = ["https://push2his.eastmoney.com", "https://push2delay.eastmoney.com"];
const EM_QUOTE_HOSTS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"];
const OZ_TO_GRAM = 31.1034768;

/** wx.request 的 Promise 封装 */
function request(url, timeout) {
  return new Promise((resolve, reject) => {
    wx.request({
      url,
      timeout: timeout || 10000,
      dataType: "json",
      success(res) {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data) {
          resolve(res.data);
        } else {
          reject(new Error("HTTP " + res.statusCode + " " + url));
        }
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || "network fail"));
      }
    });
  });
}

/** 周期 -> 起止日期（YYYYMMDD），klt=101 日线 */
function dateRange(period) {
  const end = new Date();
  const start = new Date(end.getTime());
  const months = { "1mo": 1, "3mo": 3, "1y": 12, "5y": 60 }[period] || 1;
  start.setMonth(start.getMonth() - months);
  start.setDate(start.getDate() - 7); // 多要几天，防止节假日缺 bar
  const fmt = (d) => {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return "" + d.getFullYear() + m + day;
  };
  return { beg: fmt(start), end: fmt(end) };
}

/** 通用 K 线（东财），返回统一结构 [{time,o,h,l,c,v}] */
async function emKline(secid, period) {
  const { beg, end } = dateRange(period);
  const query = "secid=" + secid + "&fields1=f1&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=" + beg + "&end=" + end;
  let data = null;
  let lastErr = null;
  for (const host of EM_HOSTS) {
    try {
      data = await request(host + "/api/qt/stock/kline/get?" + query);
      if (data && data.data && data.data.klines && data.data.klines.length) break;
    } catch (e) {
      lastErr = e;
      data = null;
    }
  }
  if (!data || !data.data || !data.data.klines || !data.data.klines.length) {
    throw lastErr || new Error("kline empty " + secid);
  }
  return data.data.klines.map((line) => {
    const p = line.split(",");
    return {
      time: p[0], // "2026-10-23"
      o: Number(p[1]),
      c: Number(p[2]),
      h: Number(p[3]),
      l: Number(p[4]),
      v: Number(p[5]) || 0
    };
  });
}

/** 通用实时行情（东财 push2，多 host 轮询），f43 系「分」单位整数 ÷100 */
async function emQuote(secid) {
  const query = "/api/qt/stock/get?secid=" + secid + "&fields=f43,f44,f45,f46,f60,f86,f169,f170";
  let lastErr = null;
  for (const host of EM_QUOTE_HOSTS) {
    try {
      const data = await request(host + query);
      const d = data && data.data;
      if (!d || !d.f43) throw new Error("quote empty " + secid);
      return {
        price: d.f43 / 100,
        open: d.f46 / 100,
        high: d.f44 / 100,
        low: d.f45 / 100,
        prevClose: d.f60 / 100,
        change: d.f169 / 100,
        changePct: d.f170 / 100,
        ts: d.f86 ? d.f86 * 1000 : Date.now()
      };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("quote unavailable " + secid);
}

/** 通用当日分时（东财 trends2），返回 {points, prevClose, source} */
async function emIntraday(secid, withAvg) {
  const query =
    "secid=" + secid + "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&iscr=0&ndays=1";
  let data = null;
  let lastErr = null;
  for (const host of EM_HOSTS) {
    try {
      data = await request(host + "/api/qt/stock/trends2/get?" + query);
      if (data && data.data && data.data.trends && data.data.trends.length) break;
    } catch (e) {
      lastErr = e;
      data = null;
    }
  }
  const d = data && data.data;
  if (!d || !d.trends || !d.trends.length) throw lastErr || new Error("intraday empty " + secid);
  // 每项："YYYY-MM-DD HH:MM,开,收,高,低,量,额,均价"
  const points = d.trends.map((line) => {
    const p = line.split(",");
    return {
      time: p[0].slice(5), // "MM-DD HH:MM"
      price: Number(p[2]),
      avg: withAvg ? Number(p[7]) : null,
      v: Number(p[5]) || 0
    };
  });
  let prevClose = d.preClose ? Number(d.preClose) : null;
  if (!prevClose) {
    // preClose 缺失时用日 K 前一根收盘兜底
    try {
      const k = await emKline(secid, "1mo");
      const today = new Date();
      const ymd = "" + today.getFullYear() + String(today.getMonth() + 1).padStart(2, "0") + String(today.getDate()).padStart(2, "0");
      const last = k[k.length - 1];
      if (last && last.time.replace(/-/g, "") === ymd && k.length >= 2) prevClose = k[k.length - 2].c;
      else if (last) prevClose = last.c;
    } catch (e) {
      /* 可选兜底 */
    }
  }
  return {
    points,
    prevClose,
    source: "东方财富"
  };
}

/** 用分时末点拼实时报价（push2/push2delay 均不可用时的兜底） */
function quoteFromIntraday(intra) {
  const pts = intra.points;
  if (!pts || !pts.length) throw new Error("intraday empty for quote");
  const first = pts[0];
  const last = pts[pts.length - 1];
  const prevClose = intra.prevClose;
  let high = -Infinity;
  let low = Infinity;
  for (const p of pts) {
    if (p.price > high) high = p.price;
    if (p.price < low) low = p.price;
  }
  const change = prevClose ? last.price - prevClose : 0;
  return {
    price: last.price,
    open: first.price,
    high: isFinite(high) ? high : last.price,
    low: isFinite(low) ? low : last.price,
    prevClose: prevClose || last.price,
    change,
    changePct: prevClose ? (change / prevClose) * 100 : 0,
    ts: Date.now(),
    source: "东方财富（分时回退）"
  };
}

/** 本地黄金展示：优先分时末点，避免先请求会空响应的 push2 报价端点。
 * 分时不可用时仍尝试报价端点；这些数据由 market-client 标记为延迟展示。
 */
async function quoteSmart(secid) {
  try {
    const intra = await emIntraday(secid, false);
    return quoteFromIntraday(intra);
  } catch (e) {
    return emQuote(secid);
  }
}

/** 沪金 K 线 */
async function getAuKline(period) {
  return emKline("118.AU9999", period);
}

/** 沪金实时行情，降级：分时末点 → K 线最后一根收盘价 */
async function getAuQuote() {
  try {
    const q = await quoteSmart("118.AU9999");
    return Object.assign(q, { source: q.source || "东方财富" });
  } catch (e) {
    const k = await getAuKline("1mo");
    const last = k[k.length - 1];
    const prev = k.length > 1 ? k[k.length - 2] : null;
    const change = prev ? last.c - prev.c : 0;
    return {
      price: last.c,
      open: last.o,
      high: last.h,
      low: last.l,
      prevClose: prev ? prev.c : last.c,
      change,
      changePct: prev ? (change / prev.c) * 100 : 0,
      ts: Date.now(),
      source: "东方财富（K线回退）"
    };
  }
}

/** 沪金当日分时（含夜盘，自带均价线） */
async function getAuIntraday() {
  return emIntraday("118.AU9999", true);
}

/** 伦敦金实时（东财 122.XAU 黄金/美元）——「国际参考」行 */
async function getXauQuote() {
  const q = await quoteSmart("122.XAU");
  return Object.assign(q, { source: q.source || "东方财富" });
}

/** USD/CNY 汇率（东财 133.USDCNH 离岸实时，降级 120.USDCNYC 中间价），字段 ÷10000 */
async function getUsdCny() {
  const secs = ["133.USDCNH", "120.USDCNYC"];
  let lastErr = null;
  for (const secid of secs) {
    try {
      const data = await request(
        EM_QUOTE_HOSTS[0] + "/api/qt/stock/get?secid=" + secid + "&fields=f43",
        8000
      );
      const d = data && data.data;
      const rate = d && d.f43 ? d.f43 / 10000 : null;
      if (rate > 5 && rate < 9) return rate;
      throw new Error("fx out of range " + secid);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("fx unavailable");
}

/**
 * 国际参考：伦敦金现价 + 汇率折算成人民币/克
 * 返回 { price, usdCny, cnyPerGram, changePct, source }（汇率拿不到时 cnyPerGram 为 null）
 */
async function getIntlRef() {
  const xau = await getXauQuote();
  let rate = null;
  try {
    rate = await getUsdCny();
  } catch (e) {
    /* 汇率失败不影响美元价展示 */
  }
  return {
    price: xau.price,
    usdCny: rate,
    cnyPerGram: rate ? (xau.price * rate) / OZ_TO_GRAM : null,
    changePct: xau.changePct,
    prevClose: xau.prevClose,
    source: xau.source
  };
}

module.exports = {
  getAuIntraday,
  getAuKline,
  getAuQuote,
  getIntlRef,
  getUsdCny,
  getXauQuote,
  getXauIntraday: () => emIntraday("122.XAU", true),
  getXauKline: (period) => emKline("122.XAU", period)
};
