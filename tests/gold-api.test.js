const { test } = require("node:test");
const assert = require("node:assert/strict");
const api = require("../utils/gold-api");

async function withRequests(handler, run) {
  const previous = global.wx;
  const urls = [];
  global.wx = { request(options) {
    urls.push(options.url);
    const data = handler(options.url);
    if (data === null) options.fail({ errMsg: "request:fail net::ERR_EMPTY_RESPONSE" });
    else options.success({ statusCode: 200, data });
  } };
  try { await run(urls); } finally { global.wx = previous; }
}

test("local gold quotes use working intraday without hitting empty-response quote hosts", async () => {
  await withRequests(url => url.includes("/trends2/get?") ? {
    data: { preClose: 860, trends: [
      "2026-10-27 09:00,861,861,861,861,1,861,861",
      "2026-10-27 09:01,861,862,862,861,1,862,861.5",
    ] },
  } : null, async urls => {
    for (const method of [api.getAuQuote, api.getXauQuote]) {
      const q = await method();
      assert.equal(q.price, 862);
      assert.equal(q.prevClose, 860);
      assert.equal(q.change, 2);
      assert.match(q.source, /分时/);
    }
    assert.equal(urls.length, 2);
    assert.ok(urls.every(url => url.startsWith("https://push2his.eastmoney.com/")));
  });
});

test("local gold quotes retain snapshot fallback when intraday is unavailable", async () => {
  await withRequests(url => url.includes("/stock/get?") ? {
    data: { f43: 86200, f44: 86400, f45: 85900, f46: 86100,
      f60: 86000, f169: 200, f170: 23, f86: 1793062800 },
  } : null, async () => {
    const q = await api.getXauQuote();
    assert.equal(q.price, 862);
    assert.equal(q.change, 2);
  });
});

test("Au daily close remains the last resort if intraday and snapshots fail", async () => {
  await withRequests(url => url.includes("/kline/get?") ? {
    data: { klines: ["2026-10-26,859,860,862,858,10", "2026-10-27,861,862,864,860,20"] },
  } : null, async () => {
    const q = await api.getAuQuote();
    assert.equal(q.price, 862);
    assert.equal(q.prevClose, 860);
    assert.match(q.source, /K线/);
  });
});
