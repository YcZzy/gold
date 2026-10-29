"use strict";
const catalog = require("./catalog.json");
const official = new Map(
  catalog.records.map((row) => [row.market.toLowerCase() + row.symbol, row]),
);
const US_EM = { AAPL: "105.AAPL", SPY: "107.SPY", "BRK.B": "106.BRK_B" };
const US_KNOWN = {
  AAPL: ["OQ", "苹果", "stock"],
  SPY: ["AM", "标普500指数ETF-SPDR", "etf"],
  "BRK.B": ["N", "伯克希尔B", "stock"],
};
const US_EXCHANGES = { OQ: "NASDAQ", N: "NYSE", AM: "NYSE_ARCA" };
const escapeRegex = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function asset(market, code, name, kind = "stock", extra = {}) {
  const currency =
    extra.currency ||
    (market === "US" ? "USD" : market === "HK" ? "HKD" : "CNY");
  const id = market.toLowerCase() + code;
  const quoteCode = market === "HK" ? "r_hk" + code : id;
  const currencyLabel =
    { CNY: "元", HKD: "港元", USD: "美元" }[currency] || currency;
  const secid =
    market === "US"
      ? US_EM[code] || "us:" + code
      : market === "HK"
        ? "116." + code
        : (market === "SH" ? "1." : "0.") + code;
  return {
    id,
    name: name || code,
    code,
    market,
    kind,
    currency,
    unit: currencyLabel + (["etf", "lof"].includes(kind) ? "/份" : "/股"),
    precision:
      market === "HK" || (["etf", "lof"].includes(kind) && ["SH", "SZ"].includes(market))
        ? 3
        : 2,
    secid,
    quoteCode,
    timezone:
      market === "US"
        ? "America/New_York"
        : market === "HK"
          ? "Asia/Hong_Kong"
          : "Asia/Shanghai",
    exchange: extra.exchange || market,
    providers: {
      tencentQuote: quoteCode,
      tencentChart: market === "HK" ? "hk" + code : id,
      ...(!secid.startsWith("us:") ? { eastmoney: secid } : {}),
      ...(market !== "US"
        ? { sina: market === "HK" ? "rt_hk" + code : id }
        : {}),
    },
    supportsClose: true,
  };
}
function usAsset(identity, name, kind = "stock") {
  const match = /^([A-Z][A-Z0-9]*(?:\.[A-Z])?)\.(OQ|N|AM)$/.exec(
    identity.toUpperCase(),
  );
  if (!match || !["stock", "etf"].includes(kind))
    throw Error("不支持的美股身份");
  const a = asset("US", match[1], name, kind, {
    exchange: US_EXCHANGES[match[2]],
  });
  a.providers.tencentChart = "us" + identity.toUpperCase();
  a.providers.tencentIdentity = identity.toUpperCase();
  return a;
}
function stockAsset(market, code, name) {
  if (market === "US") {
    const k = US_KNOWN[code];
    if (!k) throw Error("美股身份需要行情验证");
    return usAsset(code + "." + k[0], name || k[1], k[2]);
  }
  if (market === "BJ" || market === "HK") {
    const row = official.get(market.toLowerCase() + code);
    if (!row) throw Error("不支持的资产代码");
    return {
      ...asset(market, code, name || row.name, row.kind || "stock", {
        currency: row.currency,
      }),
      identityVerified: "official",
      typeVerified: "official",
    };
  }
  const stock =
    (market === "SH" && /^(60|68)\d{4}$/.test(code)) ||
    (market === "SZ" && /^(000|001|002|003|300|301)\d{3}$/.test(code));
  const etf =
    (market === "SH" && /^(51|52|56|58)\d{4}$/.test(code)) ||
    (market === "SZ" && /^159\d{3}$/.test(code));
  // Code ranges only select a candidate; provider type evidence is still required.
  const lof =
    (market === "SH" && /^(501|502)\d{3}$/.test(code)) ||
    (market === "SZ" && /^16\d{4}$/.test(code));
  if (!stock && !etf && !lof) throw Error("不支持的资产代码");
  return asset(market, code, name, lof ? "lof" : etf ? "etf" : "stock");
}
function canonical(id) {
  if (typeof id !== "string") throw Error("无效资产代码");
  let match =
    /^(sh|sz|bj)(\d{6})$/.exec(id) ||
    /^(hk)(\d{5})$/.exec(id) ||
    /^(us)([A-Z][A-Z0-9]*(?:\.[A-Z])?)$/.exec(id);
  if (!match) throw Error("无效资产代码");
  return stockAsset(match[1].toUpperCase(), match[2]);
}
function catalogSearch(keyword) {
  const q = keyword.toLowerCase();
  return catalog.records
    .filter((r) =>
      (r.symbol + " " + r.name + " " + (r.englishName || ""))
        .toLowerCase()
        .includes(q),
    )
    .slice(0, 40)
    .map((r) => stockAsset(r.market, r.symbol, r.name));
}
function searchCandidates(value) {
  const results = [];
  for (const row of value.split("^")) {
    const [market, code, name, initials, type] = row.split("~");
    if (!name) continue;
    try {
      let a;
      if (["sh", "sz"].includes(market) && ["GP-A", "ETF", "LOF", "QDII-LOF"].includes(type)) {
        a = stockAsset(market.toUpperCase(), code, name);
        const expectedKind = { "GP-A": "stock", ETF: "etf", LOF: "lof", "QDII-LOF": "lof" }[type];
        if (a.kind !== expectedKind) continue;
      } else if (market === "hk" && type === "GP")
        a = stockAsset("HK", code, name);
      else if (market === "us" && type === "GP") a = usAsset(code, name);
      else continue;
      results.push(a);
    } catch (_) {}
  }
  return results;
}
function quoteFields(body, a) {
  const match = new RegExp(
    "(?:^|[;\\s])v_" + escapeRegex(a.quoteCode) + '="([^"\\r\\n]*)"',
  ).exec(body);
  return match ? match[1].split("~") : null;
}
function verifiedQuoteAsset(a, p) {
  if (!p || !p[1]) return null;
  if (a.market === "US") {
    if (
      p[2] !== a.providers.tencentIdentity ||
      p[35] !== "USD" ||
      !["GP", "GP-ETF"].includes(p[56])
    )
      return null;
    return quotePrecision(
      {
        ...usAsset(p[2], p[1], p[56] === "GP-ETF" ? "etf" : "stock"),
        identityVerified: "tencent",
        typeVerified: "tencent",
      },
      p[3],
    );
  }
  if (p[2] !== a.code) return null;
  if (a.market === "HK") {
    if (p[75] !== a.currency || p[63] !== (a.kind === "etf" ? "GP-FUND" : "GP"))
      return null;
  } else if (a.kind === "etf" && p[61] !== "ETF") return null;
  else if (a.kind === "lof" && (p[61] !== "LOF" || p[82] !== "CNY" || !["SH", "SZ"].includes(a.market))) return null;
  else if (a.market === "BJ" && p[61] !== "GP") return null;
  else if (
    a.kind === "stock" &&
    ["SH", "SZ"].includes(a.market) &&
    p[61] &&
    p[61] !== "GP-A"
  )
    return null;
  return quotePrecision(
    {
      ...a,
      name: p[1],
      identityVerified: "tencent",
      ...(p[61] || a.market === "HK" ? { typeVerified: "tencent" } : {}),
    },
    p[3],
  );
}
function quotePrecision(asset, rawPrice) {
  const match = /^\d+\.(\d{1,6})$/.exec(String(rawPrice || ""));
  return {
    ...asset,
    precision: Math.max(asset.precision, match ? match[1].length : 0),
  };
}
function restoreAsset(saved) {
  const base =
    saved.market === "US" && saved.providers?.tencentIdentity
      ? usAsset(saved.providers.tencentIdentity, saved.name, saved.kind)
      : canonical(saved.id);
  if (base.kind === "lof" && (saved.typeVerified !== "tencent" || saved.identityVerified !== "tencent"))
    throw Error("缓存LOF身份未经验证");
  if (base.id !== saved.id || (saved.kind && saved.kind !== base.kind))
    throw Error("缓存资产身份无效");
  if (
    Number.isInteger(saved.precision) &&
    saved.precision >= base.precision &&
    saved.precision <= 6
  )
    base.precision = saved.precision;
  if (typeof saved.name === "string" && saved.name) base.name = saved.name;
  const sources = ["tencent", "eastmoney", "official", "validation-2026-10-28"];
  for (const key of ["identityVerified", "typeVerified"])
    if (sources.includes(saved[key])) base[key] = saved[key];
  const candidate = eastmoneyCandidate(base);
  if (
    candidate &&
    saved.providers?.eastmoneyVerified === "metadata+raw-chart" &&
    saved.providers.eastmoney === candidate.secid
  ) {
    base.secid = candidate.secid;
    base.providers.eastmoney = candidate.secid;
    base.providers.eastmoneyVerified = "metadata+raw-chart";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(saved.historyAvailableFrom || ""))
    base.historyAvailableFrom = saved.historyAvailableFrom;
  if (/^\d{4}-\d{2}-\d{2}$/.test(saved.historyRangeConfirmedFrom || ""))
    base.historyRangeConfirmedFrom = saved.historyRangeConfirmedFrom;
  return base;
}
function eastmoneyCandidate(asset) {
  if (asset.market !== "US" || !asset.providers?.tencentIdentity) return null;
  const match = /^([A-Z][A-Z0-9]*(?:\.[A-Z])?)\.(OQ|N|AM)$/.exec(
    asset.providers.tencentIdentity,
  );
  if (!match || "us" + match[1] !== asset.id) return null;
  const market = { OQ: 105, N: 106, AM: 107 }[match[2]],
    code = match[1].replace(".", "_");
  return { secid: market + "." + code, market, code };
}
function mergeEvidence(previous, observed) {
  if (!previous || previous.id !== observed.id) return observed;
  let trusted;
  try { trusted = restoreAsset(previous); } catch (_) { return observed; }
  if (['market','code','kind','currency'].some(key => trusted[key] !== observed[key]) ||
      trusted.providers.tencentIdentity !== observed.providers?.tencentIdentity) return observed;
  const merged = { ...observed, providers: { ...trusted.providers, ...observed.providers },
    precision: Math.max(trusted.precision, observed.precision) };
  const mapped=eastmoneyCandidate(merged);
  if (mapped && merged.providers.eastmoneyVerified === 'metadata+raw-chart' && merged.providers.eastmoney === mapped.secid)
    merged.secid=mapped.secid;
  for (const key of ['historyAvailableFrom','historyRangeConfirmedFrom']) {
    const dates=[trusted[key],observed[key]].filter(value => /^\d{4}-\d{2}-\d{2}$/.test(value || '')).sort();
    if (dates.length) merged[key]=dates[0];
  }
  for (const key of ['identityVerified','typeVerified']) if (!merged[key] && trusted[key]) merged[key]=trusted[key];
  return merged;
}
module.exports = {
  stockAsset,
  canonical,
  restoreAsset,
  eastmoneyCandidate,
  mergeEvidence,
  catalogSearch,
  searchCandidates,
  quoteFields,
  verifiedQuoteAsset,
  usAsset,
  escapeRegex,
  catalogVersion: catalog.version,
};
