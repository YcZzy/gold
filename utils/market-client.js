/** Server-authoritative market data. All methods resolve to {ok,...} envelopes. */
async function callMarket(action, data) {
  if (typeof wx === "undefined" || !wx.cloud || !wx.cloud.callFunction) {
    const error = new Error("云开发尚未初始化");
    error.code = "market-cloud-connection-failed";
    throw error;
  }
  let response;
  try {
    response = await wx.cloud.callFunction({
      name: "marketData",
      data: Object.assign({ action }, data || {}),
    });
  } catch (cause) {
    // Local compatibility may succeed and otherwise hide cloud runtime/deployment errors.
    console.warn("[marketData] 云函数调用失败", {
      action,
      errCode: cause && cause.errCode,
      errMsg: (cause && (cause.errMsg || cause.message)) || String(cause),
    });
    const error = new Error("行情服务连接失败，请稍后重试");
    error.cause = cause;
    error.code = "market-cloud-connection-failed";
    throw error;
  }
  const result = response && response.result;
  if (!result || result.ok !== true) {
    const error = new Error((result && result.hint) || "行情服务暂不可用");
    error.hint = error.message;
    error.code = (result && result.err) || "market-data-unavailable";
    throw error;
  }
  return result;
}
// Compatibility display path while the new cloud function is being deployed.
// It never supplies a verified source timestamp for legacy quote helpers.
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
function localAsset(id) {
  if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(GOLD, id))
    throw Error("行情服务暂不可用，股票需部署行情云函数后查看");
  return Object.assign({}, GOLD[id]);
}
async function localQuote(id) {
  const asset = localAsset(id),
    api = require("./gold-api");
  const raw = await (id === "gold-au9999"
    ? api.getAuQuote()
    : api.getXauQuote());
  if (!raw || !Number.isFinite(Number(raw.price)) || Number(raw.price) <= 0)
    throw Error("黄金行情暂不可用");
  const quote = {
    assetId: id,
    price: Number(raw.price),
    prevClose: raw.prevClose == null ? null : raw.prevClose,
    change: raw.change == null ? null : raw.change,
    changePct: raw.changePct == null ? null : raw.changePct,
    open: raw.open == null ? null : raw.open,
    high: raw.high == null ? null : raw.high,
    low: raw.low == null ? null : raw.low,
    volume: raw.volume == null ? null : raw.volume,
    amount: raw.amount == null ? null : raw.amount,
    source: (raw.source || "东方财富") + "（本地回退）",
    sourceTime: null,
    fetchedAt: Date.now(),
    stale: false,
    status: "delayed",
  };
  return { ok: true, asset, quote };
}
function chartSourceTime(value) {
  // Legacy intraday helpers strip the year. Keep those point labels but do not guess a year.
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}(:\d{2})?)?$/.test(value)
  )
    return null;
  const time = Date.parse(
    value.replace(" ", "T") +
      (value.length === 10 ? "T00:00:00" : "") +
      "+08:00",
  );
  return Number.isFinite(time) && time <= Date.now() + 300000 ? time : null;
}
async function localChart(id, period) {
  const asset = localAsset(id),
    api = require("./gold-api");
  if (!["intraday", "1mo", "3mo", "1y", "5y"].includes(period))
    throw Error("不支持的图表周期");
  const intraday = period === "intraday";
  const raw = await (intraday
    ? id === "gold-au9999"
      ? api.getAuIntraday()
      : api.getXauIntraday()
    : id === "gold-au9999"
      ? api.getAuKline(period)
      : api.getXauKline(period));
  const rows = intraday ? raw && raw.points : raw;
  if (!Array.isArray(rows) || !rows.length) throw Error("黄金图表暂不可用");
  const chart = {
    mode: intraday ? "intraday" : "candle",
    prevClose: (intraday && raw.prevClose) || null,
    source: (raw.source || "东方财富") + "（本地回退）",
    sourceTime: chartSourceTime(rows[rows.length - 1].time),
    fetchedAt: Date.now(),
    stale: true,
  };
  chart[intraday ? "points" : "candles"] = rows;
  return { ok: true, asset, chart };
}
async function withGoldFallback(action, data) {
  try {
    return await callMarket(action, data);
  } catch (error) {
    if (error.code !== "market-cloud-connection-failed") throw error;
    if (action === "resolve")
      return { ok: true, asset: localAsset(data.assetId) };
    if (action === "quote") return localQuote(data.assetId);
    if (action === "chart") return localChart(data.assetId, data.period);
    if (action === "quotes") {
      if (
        !Array.isArray(data.assetIds) ||
        !data.assetIds.length ||
        data.assetIds.length > 30
      )
        throw Error("请传入 1 至 30 个资产代码");
      const assets = [],
        quotes = [],
        errors = [];
      await Promise.all(
        [...new Set(data.assetIds)].map(async (id) => {
          try {
            const result = await localQuote(id);
            assets.push(result.asset);
            quotes.push(result.quote);
          } catch (cause) {
            errors.push({
              assetId: id,
              hint: cause.message || "行情服务暂不可用",
            });
          }
        }),
      );
      return { ok: true, assets, quotes, errors };
    }
    throw error;
  }
}
const caches = require("./read-cache");
function cache() { return typeof wx === "undefined" ? caches : caches.forPlatform(wx); }
function usableQuote(q) {
  return !!(q && q.price != null && Number.isFinite(Number(q.price)) && Number(q.price) > 0 && q.status !== "unavailable");
}
// A fallback preserves provider time and explicitly identifies the stored snapshot.
function cachedResult(result) {
  if (!result) return result;
  const copy = { ...result, cached: true };
  if (copy.quote) copy.quote = { ...copy.quote, stale: true, status: "delayed", cached: true };
  if (copy.chart) copy.chart = { ...copy.chart, stale: true, cached: true };
  return copy;
}
function remember(result) {
  if (result.asset && result.asset.id) cache().write("asset:" + result.asset.id, result.asset);
  return result;
}
async function readMarket(key, request, valid) {
  try {
    const result = remember(await request());
    if (!valid(result)) throw Error("行情数据暂不可用");
    return cache().write(key, result);
  } catch (error) {
    if (["unknown-asset", "invalid-asset", "invalid-period"].includes(error.code)) throw error;
    const previous = cache().read(key);
    if (previous) return cachedResult(previous);
    if (key.startsWith("resolve:")) {
      const asset = cache().read("asset:" + key.slice("resolve:".length));
      if (asset) return { ok: true, asset };
    }
    throw error;
  }
}
const search = (keyword) => readMarket("search:" + keyword.trim(), () => callMarket("search", { keyword }), r => Array.isArray(r.assets || r.items));
const resolve = (assetId) => readMarket("resolve:" + assetId, () => withGoldFallback("resolve", { assetId }), r => !!r.asset);
async function quote(assetId) {
  return readMarket("quote:" + assetId,
    () => withGoldFallback("quote", { assetId }), r => usableQuote(r.quote));
}
async function quotes(assetIds) {
  let result;
  try { result = await withGoldFallback("quotes", { assetIds }); }
  catch (error) {
    const previous = assetIds.map(id => cache().read("quote:" + id)).filter(Boolean);
    if (!previous.length) throw error;
    return { ok: true, quotes: previous.map(r => cachedResult(r).quote), errors: [] };
  }
  for (const asset of result.assets || []) cache().write("asset:" + asset.id, asset);
  return { ...result, quotes: assetIds.map(id => {
    const q = (result.quotes || []).find(q => q.assetId === id);
    const old = cache().read("quote:" + id);
    if (!usableQuote(q)) return old && cachedResult(old).quote;
    cache().write("quote:" + id, { ok: true, quote: q });
    return q;
  }).filter(Boolean) };
}
const chart = (assetId, period = "intraday") => readMarket("chart:" + assetId + ":" + period,
  () => withGoldFallback("chart", { assetId, period }), r => {
    const rows = r.chart && (r.chart.points || r.chart.candles);
    return Array.isArray(rows) && rows.length > 0;
  });
module.exports = {
  callMarket,
  search,
  resolve,
  quote,
  quotes,
  chart,
  searchAssets: search,
  resolveAsset: resolve,
  getQuote: quote,
  getQuotes: quotes,
  getChart: chart,
};
