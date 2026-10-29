// 只读真实接口验收；不连接用户数据库，不发送微信消息。
const https = require("node:https");
const fs = require("node:fs");
const path = require("node:path");
const { createService } = require("../cloudfunctions/marketData");

function memoryStore() {
  const data = new Map();
  return {
    get: async (collection, key) => data.get(collection + ":" + key),
    set: async (collection, key, value) => data.set(collection + ":" + key, value),
    search: async keyword => [...data.entries()].filter(([key]) => key.startsWith("instruments:")).map(([, row]) => row).filter(row => row.asset && (row.asset.name.includes(keyword) || row.asset.code.includes(keyword)))
  };
}
function request(url, timeout = 3000) {
  return new Promise((resolve, reject) => {
    const referer = url.includes("sge.com.cn") ? "https://www.sge.com.cn/sjzx/mrhq" : url.includes("sina.com.cn") || url.includes("sinajs.cn") ? "https://finance.sina.com.cn/" : "https://gu.qq.com/";
    const req = https.get(url, { headers: { "User-Agent": "Mozilla/5.0", "Referer": referer } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error("HTTP " + response.statusCode)); return; }
      const chunks = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve(Buffer.concat(chunks)));
      response.on("error", reject);
    });
    req.setTimeout(timeout, () => req.destroy(Error("timeout")));
    req.on("error", reject);
  });
}
async function run() {
  const service = createService({ store: memoryStore() });
  const report = { checkedAt: new Date().toISOString(), environment: "local-node-readonly", tests: [] };
  async function check(label, fn) {
    const started = Date.now();
    try {
      const detail = await fn();
      const row = { label, ok: true, elapsedMs: Date.now() - started, ...detail };
      report.tests.push(row);
      console.log("PASS", label, JSON.stringify(detail));
    } catch (error) {
      const row = { label, ok: false, elapsedMs: Date.now() - started, error: error.message };
      report.tests.push(row);
      console.log("FAIL", label, error.message);
    }
  }
  const requireOk = value => { if (!value || !value.ok) throw Error(value && value.hint || "empty result"); return value; };
  for (const [keyword, expected] of [["茅", "sh600519"], ["gzmt", "sh600519"], ["600519", "sh600519"], ["平安", "sz000001"], ["300750", "sz300750"]]) {
    await check("search:" + keyword, async () => {
      const result = requireOk(await service.handle({ action: "search", keyword }));
      if (!result.assets.some(asset => asset.id === expected && asset.name && asset.name !== asset.code)) throw Error("expected exact named asset not found");
      return { source: result.source, count: result.assets.length, expectedAsset: expected };
    });
  }
  await check("mixed-batch-quotes", async () => {
    const ids = ["sh600519", "sz000001", "sz300750", "gold-au9999", "gold-xauusd"];
    const result = requireOk(await service.handle({ action: "quotes", assetIds: ids }));
    if (result.errors.length || result.quotes.length !== ids.length) throw Error(JSON.stringify(result.errors));
    const rows = result.quotes.map(quote => {
      const asset = result.assets.find(asset => asset.id === quote.assetId);
      if (!asset || !Number.isFinite(quote.price) || quote.price <= 0) throw Error("invalid quote identity or price");
      return { assetId: quote.assetId, name: asset.name, unit: asset.unit, source: quote.source,
        timestampPresent: Number.isFinite(quote.sourceTime) && quote.sourceTime > 0,
        sourceTime: quote.sourceTime ? new Date(quote.sourceTime).toISOString() : null,
        status: quote.status, stale: quote.stale };
    });
    return { quotes: rows };
  });
  for (const assetId of ["sh600519", "sz300750", "gold-au9999", "gold-xauusd"]) for (const period of ["intraday", "1mo"]) {
    await check("chart:" + assetId + ":" + period, async () => {
      const result = requireOk(await service.handle({ action: "chart", assetId, period }));
      const rows = result.chart.points || result.chart.candles || [];
      if (!rows.length || result.asset.id !== assetId) throw Error("empty or wrong-asset chart");
      return { source: result.chart.source, mode: result.chart.mode, count: rows.length, first: rows[0].time, last: rows[rows.length - 1].time, stale: result.chart.stale };
    });
  }
  // 让主源主动失败，再实际请求备用源，验证兜底适配与网络均可用。
  const fallback = createService({ store: memoryStore(), request: (url, timeout) => {
    if (url.startsWith("https://qt.gtimg.cn/") || url.startsWith("https://push2his.eastmoney.com/") || url.startsWith("https://searchapi.eastmoney.com/")) return Promise.reject(Error("intentional primary outage"));
    return request(url, timeout);
  } });
  await check("forced-fallback:search", async () => {
    const result = requireOk(await fallback.handle({ action: "search", keyword: "600519" }));
    if (!result.assets.some(a => a.id === "sh600519")) throw Error("fallback exact match missing");
    return { source: result.source };
  });
  await check("forced-fallback:quotes", async () => {
    const result = requireOk(await fallback.handle({ action: "quotes", assetIds: ["sh600519", "sz000001"] }));
    if (result.quotes.length !== 2 || result.errors.length) throw Error(JSON.stringify(result.errors));
    return { sources: result.quotes.map(q => ({ assetId: q.assetId, source: q.source, timestampPresent: !!q.sourceTime, status: q.status })) };
  });
  for (const period of ["intraday", "1mo"]) await check("forced-fallback:chart:" + period, async () => {
    const result = requireOk(await fallback.handle({ action: "chart", assetId: "sh600519", period }));
    const rows = result.chart.points || result.chart.candles || [];
    if (!rows.length || !["tencent", "sina"].includes(result.chart.source) || result.chart.stale) throw Error("no usable validated fallback chart");
    return { source: result.chart.source, count: rows.length };
  });
  report.passed = report.tests.filter(row => row.ok).length;
  report.failed = report.tests.length - report.passed;
  const date = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const output = path.join(__dirname, "../docs/api-smoke-" + date + ".json");
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  console.log("RESULT", JSON.stringify({ passed: report.passed, failed: report.failed, report: output }));
  process.exitCode = report.failed ? 1 : 0;
}
run().catch(error => { console.error(error.message); process.exitCode = 1; });
