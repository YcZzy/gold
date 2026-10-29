"use strict";
// Tencent's three transports share the same upstream data; they are not independent feeds.
function routes(asset, period, eastmoneyUrl) {
  const intra = period === "intraday",
    code = asset.providers?.tencentChart || asset.quoteCode;
  const path = intra
    ? `${asset.market === "US" ? "usMinute" : "minute"}/query?code=${code}`
    : `fqkline/get?param=${code},day,,,1500,`;
  const tencent = [
    "https://web.ifzq.gtimg.cn/appstock/app/",
    "https://proxy.finance.qq.com/ifzqgtimg/appstock/app/",
    "https://ifzq.gtimg.cn/appstock/app/",
  ].map((host) => ({ url: host + path, parser: "tencent" }));
  const em = asset.providers?.eastmoney
    ? [{ url: eastmoneyUrl, parser: "eastmoney" }]
    : [];
  if (asset.market === "US" && intra && em.length)
    em.push({
      url: eastmoneyUrl
        .replace("/trends2/get?", "/kline/get?")
        .replace(
          /&ndays=1&iscr=0/,
          "&klt=1&fqt=0&beg=20200101&end=20500101&lmt=1500",
        ),
      parser: "eastmoney",
    });
  if (asset.market === "BJ" && !intra)
    return [
      ...em,
      {
        url: `https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${asset.quoteCode}&scale=240&ma=no&datalen=1500`,
        parser: "sina",
      },
    ];
  return [...tencent, ...em, ...(['SH','SZ'].includes(asset.market) ? [{
    url:`https://quotes.sina.cn/cn/api/json_v2.php/CN_MarketDataService.getKLineData?symbol=${asset.quoteCode}&scale=${intra ? 1 : 240}&ma=no&datalen=1500`,
    parser:'sina',
  }] : [])];
}
function sinaRows(input, intraday = false) {
  const body = Buffer.isBuffer(input) ? input.toString("utf8") : input;
  const rows = typeof body === "string" ? JSON.parse(body) : body;
  if (!Array.isArray(rows)) throw Error("日K响应无效");
  if (intraday) {
    const day=String(rows.at(-1)?.day || '').slice(0,10);
    return rows.filter(row=>String(row.day).slice(0,10)===day)
      .map(row=>[String(row.day),row.close,null,null]);
  }
  return rows.map((p) => [
    String(p.day || "").slice(0, 10),
    p.open,
    p.close,
    p.high,
    p.low,
    p.volume,
  ]);
}
module.exports = { routes, sinaRows };
