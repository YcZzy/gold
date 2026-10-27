"use strict";
// Pure adapters and createService are exported for callers and offline tests.
const https = require("https");
const FRESH_MS = 15 * 60 * 1000;
const CACHE_MS = 7 * 86400000;
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
function stockAsset(market, code, name) {
  if (
    !(
      (market === "SH" && /^(60|68)\d{4}$/.test(code)) ||
      (market === "SZ" && /^(000|001|002|003|300|301)\d{3}$/.test(code))
    )
  )
    throw Error("不支持的资产代码");
  return {
    id: market.toLowerCase() + code,
    name: name || code,
    code,
    market,
    kind: "stock",
    currency: "CNY",
    unit: "元/股",
    secid: (market === "SH" ? "1." : "0.") + code,
    quoteCode: market.toLowerCase() + code,
    precision: 2,
  };
}
function canonical(id) {
  if (typeof id !== "string") throw Error("无效资产代码");
  if (Object.prototype.hasOwnProperty.call(GOLD, id)) return { ...GOLD[id] };
  const m = /^(sh|sz)(\d{6})$/.exec(id || "");
  if (!m) throw Error("无效资产代码");
  return stockAsset(m[1].toUpperCase(), m[2]);
}
function positive(v) {
  if (v === null || v === undefined || v === "" || v === "-") return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function number(v) {
  return v === null || v === undefined || v === "" || v === "-"
    ? null
    : Number.isFinite(Number(v))
      ? Number(v)
      : null;
}
function sourceTime(value, now) {
  let t = null;
  if (typeof value === "number" || /^\d{10,13}$/.test(String(value || ""))) {
    t = Number(value);
    if (t < 1e12) t *= 1000;
  } else if (/^\d{14}$/.test(String(value || ""))) {
    const s = String(value);
    t = Date.parse(
      `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+08:00`,
    );
  } else if (
    /^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(String(value || ""))
  )
    t = Date.parse(
      String(value).replace(" ", "T") +
        (String(value).length === 10 ? "T00:00:00" : "") +
        "+08:00",
    );
  return Number.isFinite(t) && t > Date.UTC(2000, 0, 1) && t <= now + 300000
    ? t
    : null;
}
function freshness(time, now) {
  return time !== null && now - time <= FRESH_MS ? "fresh" : "delayed";
}
function quoteShape(asset, fields, source, time, now) {
  const price = positive(fields.price);
  if (!price) throw Error("行情价格无效");
  return {
    assetId: asset.id,
    price,
    prevClose: positive(fields.prevClose),
    change: number(fields.change),
    changePct: number(fields.changePct),
    open: positive(fields.open),
    high: positive(fields.high),
    low: positive(fields.low),
    volume: number(fields.volume),
    amount: number(fields.amount),
    source,
    sourceTime: time,
    fetchedAt: now,
    stale: false,
    status: freshness(time, now),
  };
}
function decodeTencent(input) {
  if (!Buffer.isBuffer(input)) return String(input);
  try {
    return require("iconv-lite").decode(input, "gb18030");
  } catch (_) {
    return new TextDecoder("gb18030").decode(input);
  }
}
function json(input) {
  return Buffer.isBuffer(input)
    ? JSON.parse(input.toString("utf8"))
    : typeof input === "string"
      ? JSON.parse(input)
      : input;
}
function parseTencentSearch(input) {
  const body = decodeTencent(input).trim();
  const match = /^v_hint\s*=\s*("(?:\\.|[^"\\])*")\s*;?\s*$/.exec(body);
  if (!match) throw Error("搜索响应无效");
  const value = JSON.parse(match[1]);
  const assets = new Map();
  for (const row of value.split("^")) {
    const [market, code, name, initials, type] = row.split("~");
    if (type !== "GP-A" || !["sh", "sz"].includes(market) || !name) continue;
    try {
      const asset = stockAsset(market.toUpperCase(), code, name);
      assets.set(asset.id, asset);
    } catch (_) {}
  }
  return [...assets.values()];
}
function parseTencentQuotes(input, assets, now = Date.now()) {
  const body = decodeTencent(input),
    result = [];
  for (const asset of assets) {
    const re = new RegExp(
      "(?:^|[;\\s])v_" + asset.quoteCode + '="([^"\\r\\n]*)"',
    );
    const match = re.exec(body);
    if (!match) continue;
    const p = match[1].split("~");
    if (p[2] !== asset.code) continue;
    try {
      result.push(
        quoteShape(
          asset,
          {
            price: p[3],
            prevClose: p[4],
            open: p[5],
            volume: p[6],
            change: p[31],
            changePct: p[32],
            high: p[33],
            low: p[34],
            amount: number(p[37]) === null ? null : Number(p[37]) * 10000,
          },
          "tencent",
          sourceTime(p[30], now),
          now,
        ),
      );
    } catch (_) {}
  }
  return result;
}
// Field mappings verified against Sina's own datas/hq.js (CN/HF updaters).
// SGE previous close/volume fields are deliberately unknown until documented.
function parseSinaQuotes(input, assets, now = Date.now()) {
  const body = decodeTencent(input),
    quotes = [];
  for (const asset of assets) {
    const symbol =
      asset.id === "gold-au9999"
        ? "SGE_AU9999"
        : asset.id === "gold-xauusd"
          ? "hf_XAU"
          : asset.quoteCode;
    if (!symbol) continue;
    const match = new RegExp(
      "(?:^|[;\\s])(?:var\\s+)?hq_str_" + symbol + '="([^"\\r\\n]*)"',
    ).exec(body);
    if (!match) continue;
    const p = match[1].split(",");
    let fields, timestamp;
    if (asset.id === "gold-au9999") {
      if (p[0] !== "AU9999") continue;
      const pct = /^[-+]?\d+(?:\.\d+)?%$/.test(p[17] || "")
        ? Number(p[17].slice(0, -1))
        : null;
      fields = { price: p[3], changePct: pct };
      timestamp = p[16];
    } else if (asset.id === "gold-xauusd") {
      const prev = positive(p[7]),
        price = positive(p[0]);
      fields = {
        price,
        prevClose: prev,
        open: p[8],
        high: p[4],
        low: p[5],
        change: price && prev ? price - prev : null,
        changePct: price && prev ? (price / prev - 1) * 100 : null,
      };
      timestamp = (p[12] || "") + " " + (p[6] || "");
    } else {
      const prev = positive(p[2]),
        price = positive(p[3]);
      fields = {
        price,
        prevClose: prev,
        open: p[1],
        high: p[4],
        low: p[5],
        volume: p[8],
        amount: p[9],
        change: price && prev ? price - prev : null,
        changePct: price && prev ? (price / prev - 1) * 100 : null,
      };
      timestamp = (p[30] || "") + " " + (p[31] || "");
    }
    try {
      quotes.push(
        quoteShape(asset, fields, "sina", sourceTime(timestamp, now), now),
      );
    } catch (_) {}
  }
  return quotes;
}
function newerQuote(first, second) {
  if (!first) return second;
  if (second && (second.sourceTime || 0) > (first.sourceTime || 0))
    return second;
  return first;
}
function parseEastmoneyQuote(input, asset, now = Date.now()) {
  const d = json(input)?.data;
  if (!d || String(d.f57).toUpperCase() !== asset.code.toUpperCase())
    throw Error("行情资产不匹配");
  const precision = Number(d.f59);
  if (!Number.isInteger(precision) || precision < 0 || precision > 6)
    throw Error("行情精度无效");
  const scale = 10 ** precision;
  const scaled = (v) => (number(v) === null ? null : Number(v) / scale);
  return quoteShape(
    asset,
    {
      price: scaled(d.f43),
      prevClose: scaled(d.f60),
      open: scaled(d.f46),
      high: scaled(d.f44),
      low: scaled(d.f45),
      change: scaled(d.f169),
      changePct: number(d.f170) === null ? null : Number(d.f170) / 100,
      volume: d.f47,
      amount: d.f48,
    },
    "eastmoney",
    sourceTime(d.f86, now) || sourceTime(d.f124, now),
    now,
  );
}
function periodStart(period, now) {
  const months = { "1mo": 1, "3mo": 3, "1y": 12, "5y": 60 }[period];
  if (!months) return null;
  const date = new Date(now + 8 * 3600000);
  date.setUTCMonth(date.getUTCMonth() - months);
  return date.toISOString().slice(0, 10);
}
function checkedRows(rows, asset, period, source, now, prevClose) {
  if (!Array.isArray(rows) || !rows.length) throw Error("暂无图表数据");
  const intra = period === "intraday";
  const start = periodStart(period, now);
  if (start) rows = rows.filter((row) => String(row[0]) >= start);
  if (!rows.length) throw Error("该周期暂无图表数据");
  let lastTime = 0;
  const values = rows.map((p) => {
    const t = sourceTime(p[0], now);
    if (!t || t < lastTime) throw Error("图表时间无效");
    lastTime = t;
    if (intra) {
      if (!positive(p[1])) throw Error("分时价格无效");
      return {
        time: p[0],
        price: Number(p[1]),
        avg: positive(p[2]),
        v: number(p[3]),
      };
    }
    const [o, c, h, l] = p.slice(1, 5).map(positive);
    if (!o || !c || !h || !l || h < Math.max(o, c, l) || l > Math.min(o, c, h))
      throw Error("K线价格无效");
    return { time: p[0], o, c, h, l, v: number(p[5]) };
  });
  return {
    mode: intra ? "intraday" : "candle",
    [intra ? "points" : "candles"]: values,
    prevClose: positive(prevClose),
    source,
    sourceTime: lastTime,
    fetchedAt: now,
    stale: false,
  };
}
function parseEastmoneyChart(input, asset, period, now = Date.now()) {
  const d = json(input)?.data;
  if (!d || String(d.code).toUpperCase() !== asset.code.toUpperCase())
    throw Error("图表资产不匹配");
  const rows =
    period === "intraday"
      ? (d.trends || []).map((line) => {
          const p = line.split(",");
          return [p[0], p[2], p[7], p[5]];
        })
      : (d.klines || []).map((line) => line.split(","));
  return checkedRows(rows, asset, period, "eastmoney", now, d.preClose);
}
function parseTencentChart(input, asset, period, now = Date.now()) {
  const d = json(input)?.data?.[asset.quoteCode];
  if (!d) throw Error("图表资产不匹配");
  if (period === "intraday") {
    const date = String(d.data?.date || "");
    const ymd = /^\d{8}$/.test(date)
      ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6)}`
      : date;
    const rows = (d.data?.data || []).map((line) => {
      const p = line.split(" ");
      return [`${ymd} ${p[0].slice(0, 2)}:${p[0].slice(2)}`, p[1], null, p[2]];
    });
    return checkedRows(
      rows,
      asset,
      period,
      "tencent",
      now,
      d.qt?.[asset.quoteCode]?.[4],
    );
  }
  // qfqday/hfqday intentionally rejected: all providers use unadjusted prices.
  return checkedRows(d.day, asset, period, "tencent", now, null);
}
function request(url, timeout = 3000) {
  const host = new URL(url).hostname;
  const headers = { "User-Agent": "Mozilla/5.0" };
  if (["hq.sinajs.cn", "stock2.finance.sina.com.cn"].includes(host))
    headers.Referer = "https://finance.sina.com.cn/";
  if (host === "www.sge.com.cn") headers.Referer = "https://www.sge.com.cn/";
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(Error("HTTP " + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          req.destroy(Error("响应过大"));
          return;
        }
        chunks.push(c);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(Error("行情请求超时")));
    req.on("error", reject);
  });
}
function createService(options = {}) {
  const now = options.now || Date.now,
    fetch = options.request || request;
  const store = options.store || {
    get: async () => null,
    set: async () => {},
    search: async () => [],
  };
  const failures = new Map();
  async function get(c, k) {
    try {
      return await store.get(c, k);
    } catch (_) {
      return null;
    }
  }
  async function set(c, k, v) {
    try {
      await store.set(c, k, v);
    } catch (_) {}
  }
  async function remote(key, url, parse) {
    if ((failures.get(key) || 0) > now()) throw Error("数据源冷却中");
    let timer;
    try {
      const raw = await Promise.race([
        fetch(url, 3000),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(Error("行情请求超时")), 3000);
        }),
      ]);
      return parse(raw);
    } catch (e) {
      failures.set(key, now() + 15000);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function resolve(id, verify = false) {
    const base = canonical(id);
    if (base.kind === "gold") return base;
    const saved = await get("instruments", id);
    if (
      saved?.asset?.id === id &&
      typeof saved.asset.name === "string" &&
      saved.asset.name !== base.code
    )
      return { ...base, name: saved.asset.name };
    if (!verify) return base;
    const result = await search(base.code);
    const exact = result.assets.find((asset) => asset.id === id);
    if (!exact) throw Error("未找到该沪深 A 股，请通过搜索选择资产");
    return exact;
  }
  const quoteUrl = (a) =>
    "https://push2.eastmoney.com/api/qt/stock/get?secid=" +
    a.secid +
    "&fields=f57,f58,f59,f43,f44,f45,f46,f47,f48,f60,f86,f124,f169,f170";
  function chartUrl(a, p, host = "https://push2his.eastmoney.com") {
    if (p === "intraday")
      return (
        host +
        "/api/qt/stock/trends2/get?secid=" +
        a.secid +
        "&fields1=f1,f2,f3,f4,f5,f6,f7,f8&fields2=f51,f52,f53,f54,f55,f56,f57,f58&ndays=1&iscr=0"
      );
    const count = { "1mo": 35, "3mo": 100, "1y": 370, "5y": 1900 }[p];
    return (
      host +
      "/api/qt/stock/kline/get?secid=" +
      a.secid +
      "&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=" +
      periodStart(p, now()).replace(/-/g, "") +
      "&end=20500101&lmt=" +
      count
    );
  }
  async function staleQuote(a) {
    const q = await get("quoteCache", a.id);
    if (
      q?.assetId === a.id &&
      positive(q.price) &&
      Number.isFinite(q.fetchedAt) &&
      now() - q.fetchedAt < CACHE_MS &&
      q.fetchedAt <= now()
    ) {
      return { ...q, stale: true, status: "delayed" };
    }
    throw Error("行情暂不可用，请稍后重试");
  }
  async function goldQuote(a) {
    let candidate;
    try {
      candidate = await remote("em-quote-" + a.id, quoteUrl(a), (raw) =>
        parseEastmoneyQuote(raw, a, now()),
      );
      if (candidate.status === "fresh") return candidate;
    } catch (_) {}
    try {
      const chart = await remote(
        "em-trend-" + a.id,
        chartUrl(a, "intraday"),
        (raw) => parseEastmoneyChart(raw, a, "intraday", now()),
      );
      const points = chart.points,
        last = points[points.length - 1],
        prev = chart.prevClose;
      const fallback = quoteShape(
        a,
        {
          price: last.price,
          prevClose: prev,
          change: prev ? last.price - prev : null,
          changePct: prev ? (last.price / prev - 1) * 100 : null,
          open: points[0].price,
          high: Math.max(...points.map((p) => p.price)),
          low: Math.min(...points.map((p) => p.price)),
          volume: last.v,
        },
        "eastmoney-intraday",
        chart.sourceTime,
        now(),
      );
      candidate = newerQuote(candidate, fallback);
      if (candidate.status === "fresh") return candidate;
    } catch (_) {}
    try {
      const symbol = a.id === "gold-au9999" ? "SGE_AU9999" : "hf_XAU";
      const quote = await remote(
        "sina-quote-" + a.id,
        "https://hq.sinajs.cn/list=" + symbol,
        (raw) => {
          const result = parseSinaQuotes(raw, [a], now())[0];
          if (!result) throw Error("新浪黄金行情无效");
          return result;
        },
      );
      candidate = newerQuote(candidate, quote);
    } catch (_) {}
    return candidate || staleQuote(a);
  }
  async function quotes(ids) {
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 30)
      throw Error("请传入 1 至 30 个资产代码");
    const unique = [...new Set(ids)],
      assets = [],
      errors = [];
    const resolved = await Promise.all(
      unique.map(async (id) => {
        try {
          return { asset: await resolve(id) };
        } catch (error) {
          return { error: { assetId: id, hint: error.message } };
        }
      }),
    );
    for (const result of resolved) {
      if (result.asset) assets.push(result.asset);
      else errors.push(result.error);
    }
    const stocks = assets.filter((a) => a.kind === "stock");
    let primary = [];
    const goldRequests = new Map(
      assets
        .filter((a) => a.kind === "gold")
        .map((a) => [
          a.id,
          goldQuote(a).then(
            (quote) => ({ quote }),
            (error) => ({ error }),
          ),
        ]),
    );
    if (stocks.length) {
      try {
        primary = await remote(
          "tencent-quotes",
          "https://qt.gtimg.cn/q=" + stocks.map((a) => a.quoteCode).join(","),
          (r) => {
            const parsed = parseTencentQuotes(r, stocks, now());
            const body = decodeTencent(r);
            for (const asset of stocks) {
              const match = new RegExp(
                "v_" + asset.quoteCode + '="([^"\\r\\n]*)"',
              ).exec(body);
              const fields = match && match[1].split("~");
              if (
                parsed.some((q) => q.assetId === asset.id) &&
                fields &&
                fields[2] === asset.code &&
                fields[1]
              )
                asset.name = fields[1];
            }
            return parsed;
          },
        );
      } catch (_) {}
    }
    await Promise.all(
      stocks
        .filter((asset) => asset.name !== asset.code)
        .map((asset) =>
          set("instruments", asset.id, { asset, updatedAt: now() }),
        ),
    );
    let sinaStocksPromise;
    function sinaStocks() {
      if (!sinaStocksPromise)
        sinaStocksPromise = remote(
          "sina-stock-quotes",
          "https://hq.sinajs.cn/list=" +
            stocks.map((asset) => asset.quoteCode).join(","),
          (raw) => {
            const result = parseSinaQuotes(raw, stocks, now());
            if (!result.length) throw Error("新浪股票行情无效");
            return result;
          },
        ).catch(() => []);
      return sinaStocksPromise;
    }
    const results = await Promise.all(
      assets.map(async (a) => {
        try {
          let q = primary.find((q) => q.assetId === a.id),
            old = q;
          if (a.kind === "gold") {
            const result = await goldRequests.get(a.id);
            if (result.error) throw result.error;
            q = result.quote;
          } else if (!q || q.status !== "fresh") {
            try {
              q = await remote("em-quote-" + a.id, quoteUrl(a), (r) =>
                parseEastmoneyQuote(r, a, now()),
              );
              if (q.status !== "fresh" && old?.sourceTime > q.sourceTime)
                q = old;
            } catch (_) {
              q = old;
            }
            if (!q || q.status !== "fresh") {
              const independent = (await sinaStocks()).find(
                (quote) => quote.assetId === a.id,
              );
              q = newerQuote(q, independent);
            }
            if (!q) q = await staleQuote(a);
          }
          if (!q.stale)
            await set("quoteCache", a.id, {
              ...q,
              expiresAt: now() + CACHE_MS,
            });
          return q;
        } catch (e) {
          errors.push({ assetId: a.id, hint: e.message });
          return null;
        }
      }),
    );
    return { ok: true, assets, quotes: results.filter(Boolean), errors };
  }
  async function chart(a, p) {
    if (!["intraday", "1mo", "3mo", "1y", "5y"].includes(p))
      throw Error("不支持的图表周期");
    const key = a.id + "-" + p,
      cached = await get("chartCache", key);
    if (
      cached &&
      cached.assetId === a.id &&
      now() - cached.chart?.fetchedAt < 60000
    )
      return { ...cached.chart };
    let c;
    try {
      c = await remote("em-chart-" + key, chartUrl(a, p), (r) =>
        parseEastmoneyChart(r, a, p, now()),
      );
    } catch (_) {
      try {
        const url =
          a.kind === "stock"
            ? p === "intraday"
              ? "https://web.ifzq.gtimg.cn/appstock/app/minute/query?code=" +
                a.quoteCode
              : "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=" +
                a.quoteCode +
                ",day,,,1500,"
            : a.id === "gold-au9999"
              ? p === "intraday"
                ? "https://www.sge.com.cn/graph/quotations?instid=Au99.99"
                : "https://www.sge.com.cn/graph/Dailyhq?instid=Au99.99"
              : p === "intraday"
                ? "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_min=/GlobalFuturesService.getGlobalFuturesMinLine?symbol=XAU"
                : "https://stock2.finance.sina.com.cn/futures/api/jsonp.php/var%20_daily=/GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU";
        c = await remote("backup-chart-" + key, url, (r) =>
          a.kind === "stock"
            ? parseTencentChart(r, a, p, now())
            : p === "intraday"
              ? require("./gold-history").parseGoldIntraday(r, a, now())
              : require("./gold-history").parseGoldHistory(r, a, p, now()),
        );
      } catch (_) {
        if (
          cached?.assetId === a.id &&
          now() - cached.chart?.fetchedAt < CACHE_MS
        )
          return { ...cached.chart, stale: true };
        throw Error("图表暂不可用，请稍后重试");
      }
    }
    await set("chartCache", key, {
      assetId: a.id,
      chart: c,
      expiresAt: now() + CACHE_MS,
    });
    return c;
  }
  async function search(keyword) {
    if (
      typeof keyword !== "string" ||
      !keyword.trim() ||
      keyword.trim().length > 40
    )
      throw Error("请输入 1 至 40 字的名称、代码或首字母");
    keyword = keyword.trim();
    const gold = Object.values(GOLD).filter((a) =>
      (a.name + a.code + a.id + "黄金")
        .toLowerCase()
        .includes(keyword.toLowerCase()),
    );
    const key = Buffer.from(keyword.toLowerCase()).toString("hex"),
      cached = await get("searchCache", key);
    if (cached && now() - cached.fetchedAt < 300000)
      return { ok: true, assets: cached.assets, source: "cache", stale: false };
    try {
      const parseSearch = (raw) => {
        const data = json(raw)?.QuotationCodeTable?.Data;
        if (!Array.isArray(data)) throw Error("搜索响应无效");
        const found = [];
        for (const item of data) {
          if (!["沪A", "深A", "沪A股", "深A股"].includes(item.SecurityTypeName))
            continue;
          try {
            const market =
              String(item.MktNum) === "1"
                ? "SH"
                : String(item.MktNum) === "0"
                  ? "SZ"
                  : "";
            found.push(stockAsset(market, item.Code, item.Name));
          } catch (_) {}
        }
        return [...gold, ...found];
      };
      let assets,
        source = "eastmoney";
      try {
        assets = await remote(
          "search-eastmoney",
          "https://searchapi.eastmoney.com/api/suggest/get?input=" +
            encodeURIComponent(keyword) +
            "&type=14&count=8",
          parseSearch,
        );
      } catch (_) {
        assets = await remote(
          "search-tencent",
          "https://smartbox.gtimg.cn/s3/?q=" +
            encodeURIComponent(keyword) +
            "&t=all",
          (raw) => [...gold, ...parseTencentSearch(raw)],
        );
        source = "tencent";
      }
      for (const asset of assets)
        await set("instruments", asset.id, { asset, updatedAt: now() });
      await set("searchCache", key, {
        assets,
        fetchedAt: now(),
        expiresAt: now() + 86400000,
      });
      return { ok: true, assets, source };
    } catch (_) {
      if (cached && now() - cached.fetchedAt < 86400000)
        return {
          ok: true,
          assets: cached.assets,
          source: "cache",
          stale: true,
        };
      let directory = [];
      try {
        directory = await store.search(keyword, 100);
      } catch (_) {}
      const safe = directory.flatMap((row) => {
        try {
          const a = row.asset || row;
          return [{ ...canonical(a.id), name: a.name }];
        } catch (_) {
          return [];
        }
      });
      if (gold.length || safe.length)
        return {
          ok: true,
          assets: [...gold, ...safe],
          source: "catalog",
          stale: true,
        };
      throw Error("搜索服务暂不可用，请稍后重试");
    }
  }
  async function handle(event = {}) {
    try {
      if (event.action === "resolve")
        return { ok: true, asset: await resolve(event.assetId, true) };
      if (event.action === "search") return await search(event.keyword);
      if (event.action === "quotes") return await quotes(event.assetIds);
      if (event.action === "quote") {
        const a = await resolve(event.assetId),
          r = await quotes([a.id]);
        if (!r.quotes.length) throw Error(r.errors[0]?.hint || "行情不可用");
        return { ok: true, asset: r.assets[0], quote: r.quotes[0] };
      }
      if (event.action === "chart") {
        const a = await resolve(event.assetId);
        return {
          ok: true,
          asset: a,
          chart: await chart(a, event.period || "intraday"),
        };
      }
      throw Error("不支持的操作");
    } catch (e) {
      return {
        ok: false,
        err: "market-data-unavailable",
        hint: e.message || "行情服务暂不可用",
      };
    }
  }
  return { handle, resolve, quotes };
}
function databaseStore(db) {
  const sweptAt = new Map();
  return {
    async get(collection, key) {
      const r = await db.collection(collection).doc(key).get();
      return r.data;
    },
    async set(collection, key, value) {
      await db.collection(collection).doc(key).set({ data: value });
      const current = Date.now();
      if (
        ["searchCache", "quoteCache", "chartCache"].includes(collection) &&
        current - (sweptAt.get(collection) || 0) > 60000
      ) {
        sweptAt.set(collection, current);
        try {
          await db
            .collection(collection)
            .where({ expiresAt: db.command.lt(current) })
            .limit(100)
            .remove();
        } catch (_) {
          /* TTL cleanup must not hide a valid provider response. */
        }
      }
    },
    async search(keyword, limit) {
      const r = await db
        .collection("instruments")
        .limit(Math.min(limit, 100))
        .get();
      const q = keyword.toLowerCase();
      return r.data.filter((row) => {
        const a = row.asset || {};
        return (
          String(a.name || "")
            .toLowerCase()
            .includes(q) || String(a.code || "").includes(q)
        );
      });
    },
  };
}
let runtime;
async function main(event) {
  if (!runtime) {
    const cloud = require("wx-server-sdk");
    cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
    runtime = createService({ store: databaseStore(cloud.database()) });
  }
  return runtime.handle(event);
}
module.exports = {
  main,
  createService,
  stockAsset,
  canonical,
  parseTencentQuotes,
  parseSinaQuotes,
  request,
  parseTencentSearch,
  parseEastmoneyQuote,
  parseEastmoneyChart,
  parseTencentChart,
  decodeTencent,
  databaseStore,
};
