const test = require("node:test");
const assert = require("node:assert/strict");
let m = {};
try {
  m = require("../cloudfunctions/marketData");
} catch (_) {}
const NOW = Date.parse("2026-10-27T02:30:00Z");
function tencent(code = "600519", time = "20261027103000", price = "1500.20") {
  const p = Array(50).fill("");
  Object.assign(p, {
    1: "贵州茅台",
    2: code,
    3: price,
    4: "1490",
    5: "1498",
    6: "123",
    30: time,
    31: "10.20",
    32: "0.68",
    33: "1502",
    34: "1495",
    37: "10000",
  });
  return `v_sh${code}="${p.join("~")}";`;
}
function em(code = "600519") {
  return {
    data: {
      f57: code,
      f58: "贵州茅台",
      f59: 2,
      f43: 150020,
      f60: 149000,
      f46: 149800,
      f44: 150200,
      f45: 149500,
      f169: 1020,
      f170: 68,
      f86: NOW / 1000,
      f124: 0,
    },
  };
}
function memory(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    get: async (c, k) => map.get(c + ":" + k) || null,
    set: async (c, k, v) => map.set(c + ":" + k, v),
    search: async () => [],
    map,
  };
}
test("safe canonical stock and gold resolution rejects arbitrary identifiers", async () => {
  assert.equal(typeof m.createService, "function");
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => {
      throw Error("offline");
    },
  });
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "gold-au9999" })).asset.secid,
    "118.AU9999",
  );
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "sh600519" })).ok,
    false,
  );
  for (const id of ["https://evil.com", "sh000001", "sz600519", "sh600519&x=1"])
    assert.equal(
      (await s.handle({ action: "resolve", assetId: id })).ok,
      false,
    );
});
test("Tencent preserves provider time and rejects wrong symbol, absent time and invalid prices", () => {
  const a = m.stockAsset("SH", "600519", "贵州茅台");
  const q = m.parseTencentQuotes(tencent(), [a], NOW)[0];
  assert.equal(q.price, 1500.2);
  assert.equal(q.sourceTime, NOW);
  assert.equal(q.status, "fresh");
  assert.equal(m.parseTencentQuotes(tencent("600520"), [a], NOW).length, 0);
  assert.equal(
    m.parseTencentQuotes(tencent("600519", "", "0"), [a], NOW).length,
    0,
  );
  const old = m.parseTencentQuotes(
    tencent("600519", "20261026103000"),
    [a],
    NOW,
  )[0];
  assert.equal(old.status, "delayed");
});
test("GB18030 bytes decode to a Chinese stock name", () => {
  const bytes = Buffer.from([0xb9, 0xf3, 0xd6, 0xdd, 0xc3, 0xa9, 0xcc, 0xa8]);
  assert.equal(m.decodeTencent(bytes), "贵州茅台");
});
test("Eastmoney uses provider precision and valid f86 when f124 is zero", () => {
  const a = m.stockAsset("SH", "600519");
  assert.equal(m.parseEastmoneyQuote(em(), a, NOW).price, 1500.2);
  const fx = em();
  fx.data.f59 = 3;
  assert.equal(m.parseEastmoneyQuote(fx, a, NOW).price, 150.02);
  assert.throws(() => m.parseEastmoneyQuote(em("000001"), a, NOW));
  const noTime = em();
  delete noTime.data.f86;
  assert.equal(m.parseEastmoneyQuote(noTime, a, NOW).sourceTime, null);
});
test("batch falls back per symbol, reports partial errors and never turns old cache fresh", async () => {
  const store = memory();
  let calls = [];
  const s = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      calls.push(url);
      if (url.includes("gtimg")) return tencent();
      if (url.includes("secid=0.000001")) throw Error("offline");
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "quotes",
    assetIds: ["sh600519", "sz000001"],
  });
  assert.equal(r.ok, true);
  assert.equal(r.quotes.length, 1);
  assert.equal(r.errors[0].assetId, "sz000001");
  assert.equal(calls.filter((x) => x.includes("gtimg")).length, 1);
  const cached = {
    ...r.quotes[0],
    sourceTime: NOW - 86400000,
    fetchedAt: NOW - 86400000,
  };
  await store.set("quoteCache", "sh600519", cached);
  const offline = m.createService({
    now: () => NOW,
    store,
    request: async () => {
      throw Error("offline");
    },
  });
  const old = await offline.handle({ action: "quote", assetId: "sh600519" });
  assert.equal(old.quote.stale, true);
  assert.equal(old.quote.sourceTime, cached.sourceTime);
  assert.equal(old.quote.status, "delayed");
});
test("invalid or old primary quote attempts backup and provider failure has a cooldown", async () => {
  let calls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      calls.push(url);
      return url.includes("gtimg") ? tencent("600519", "20261026103000") : em();
    },
  });
  const r = await s.handle({ action: "quote", assetId: "sh600519" });
  assert.equal(r.quote.source, "eastmoney");
  assert.equal(calls.length, 2);
});
test("search filters Shanghai/Shenzhen stocks, persists names, and distinguishes failure from no match", async () => {
  const store = memory();
  const s = m.createService({
    now: () => NOW,
    store,
    request: async () => ({
      QuotationCodeTable: {
        Data: [
          {
            Code: "600519",
            Name: "贵州茅台",
            MktNum: "1",
            SecurityTypeName: "沪A",
          },
          {
            Code: "00700",
            Name: "腾讯控股",
            MktNum: "116",
            SecurityTypeName: "港股",
          },
        ],
      },
    }),
  });
  const r = await s.handle({ action: "search", keyword: "茅" });
  assert.equal(r.assets.length, 1);
  assert.equal(r.assets[0].id, "sh600519");
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "sh600519" })).asset.name,
    "贵州茅台",
  );
  const fail = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => {
      throw Error("offline");
    },
  });
  assert.equal(
    (await fail.handle({ action: "search", keyword: "不存在" })).ok,
    false,
  );
  const empty = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => ({ QuotationCodeTable: { Data: [] } }),
  });
  assert.deepEqual(
    (await empty.handle({ action: "search", keyword: "不存在" })).assets,
    [],
  );
});
test("gold quote fallback and unadjusted charts retain actual bar timestamps", async () => {
  let urls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      urls.push(url);
      if (url.includes("/stock/get")) throw Error("offline");
      return {
        data: {
          code: "AU9999",
          trends: ["2026-10-26 15:30,900,901,902,899,3,2700,900"],
        },
      };
    },
  });
  const g = await s.handle({ action: "quote", assetId: "gold-au9999" });
  assert.equal(g.ok, true);
  assert.equal(g.quote.price, 901);
  assert.equal(g.quote.status, "delayed");
  assert.equal(g.quote.sourceTime, Date.parse("2026-10-26T15:30:00+08:00"));
  const c = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      urls.push(url);
      return {
        data: { code: "600519", klines: ["2026-10-27,1498,1500,1502,1495,30"] },
      };
    },
  });
  const r = await c.handle({
    action: "chart",
    assetId: "sh600519",
    period: "1mo",
  });
  assert.equal(r.chart.mode, "candle");
  assert.equal(r.chart.candles[0].c, 1500);
  assert.ok(urls.at(-1).includes("fqt=0"));
  assert.equal(
    (await c.handle({ action: "chart", assetId: "sh600519", period: "evil" }))
      .ok,
    false,
  );
});
test("Tencent fallback charts accept only unadjusted rows for matching asset", () => {
  const a = m.stockAsset("SH", "600519");
  const d = {
    data: {
      sh600519: { day: [["2026-10-26", "1490", "1500", "1502", "1488", "4"]] },
    },
  };
  assert.equal(m.parseTencentChart(d, a, "1mo", NOW).candles[0].c, 1500);
  assert.throws(() =>
    m.parseTencentChart(
      { data: { sh600519: { qfqday: d.data.sh600519.day } } },
      a,
      "1mo",
      NOW,
    ),
  );
});
test("market client returns result envelopes and rejects provider failures with hint", async () => {
  let client = {};
  try {
    client = require("../utils/market-client");
  } catch (_) {}
  assert.equal(typeof client.quote, "function");
  global.wx = {
    cloud: {
      callFunction: async ({ name, data }) => ({
        result:
          data.assetId === "bad"
            ? { ok: false, err: "unavailable", hint: "暂不可用" }
            : { ok: true, asset: { id: data.assetId }, quote: { price: 123 } },
      }),
    },
  };
  const r = await client.quote("sh600519");
  assert.equal(r.quote.price, 123);
  assert.equal(r.ok, true);
  await assert.rejects(client.quote("bad"), /暂不可用/);
  delete global.wx;
});
test("resolve verifies missing catalog entries by exact code and market and stores real names", async () => {
  const store = memory();
  let calls = 0;
  const s = m.createService({
    now: () => NOW,
    store,
    request: async () => {
      calls++;
      return {
        QuotationCodeTable: {
          Data: [
            {
              Code: "600519",
              Name: "贵州茅台",
              MktNum: "1",
              SecurityTypeName: "沪A",
            },
          ],
        },
      };
    },
  });
  const r = await s.handle({ action: "resolve", assetId: "sh600519" });
  assert.equal(r.asset.name, "贵州茅台");
  await s.handle({ action: "resolve", assetId: "sh600519" });
  assert.equal(calls, 1);
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "sh600520" })).ok,
    false,
  );
});
test("delayed live gold remains displayable when its secondary route fails", async () => {
  const fixture = em("AU9999");
  fixture.data.f86 = (NOW - 86400000) / 1000;
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("/stock/get")) return fixture;
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "quote", assetId: "gold-au9999" });
  assert.equal(r.ok, true);
  assert.equal(r.quote.status, "delayed");
  assert.equal(r.quote.sourceTime, NOW - 86400000);
});
test("Tencent quotes persist Chinese names in catalog and normalize amount into CNY", async () => {
  const store = memory();
  const s = m.createService({
    now: () => NOW,
    store,
    request: async () => tencent(),
  });
  const r = await s.handle({ action: "quotes", assetIds: ["sh600519"] });
  assert.equal(r.assets[0].name, "贵州茅台");
  assert.equal(r.quotes[0].amount, 100000000);
  assert.equal(
    (await store.get("instruments", "sh600519")).asset.name,
    "贵州茅台",
  );
});
test("mixed watchlist starts gold and stock providers concurrently to keep two-route latency bounded", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const urls = [];
  const gold = em("AU9999");
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      urls.push(url);
      if (url.includes("gtimg")) return pending;
      return gold;
    },
  });
  const result = s.handle({
    action: "quotes",
    assetIds: ["sh600519", "gold-au9999"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(urls.some((url) => url.includes("secid=118.AU9999")));
  release(tencent());
  assert.equal((await result).quotes.length, 2);
});
test("database search cache writes remove expired keywords with a bounded sweep", async () => {
  const operations = [];
  const db = {
    command: { lt: (v) => ({ lt: v }) },
    collection: (name) => ({
      doc: (key) => ({ set: async () => operations.push(["set", name, key]) }),
      where: (condition) => ({
        limit: (n) => ({
          remove: async () => operations.push(["prune", name, condition, n]),
        }),
      }),
    }),
  };
  await m.databaseStore(db).set("searchCache", "keyword", {
    fetchedAt: NOW,
    expiresAt: NOW + 86400000,
  });
  assert.equal(
    operations.some(
      (op) => op[0] === "prune" && op[1] === "searchCache" && op[3] === 100,
    ),
    true,
  );
});
test("Tencent batch parser accepts newline-separated symbols and Latin characters in names", () => {
  const first = tencent().replace("贵州茅台", "ST Star");
  const second = tencent("000001").replace("v_sh000001", "v_sz000001");
  const rows = m.parseTencentQuotes(
    first + "\n" + second,
    [m.stockAsset("SH", "600519"), m.stockAsset("SZ", "000001")],
    NOW,
  );
  assert.equal(rows.length, 2);
});
test("watchlist catalog reads run concurrently instead of serial database round trips", async () => {
  let release;
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const read = [];
  const s = m.createService({
    now: () => NOW,
    store: {
      get: async (c, k) => {
        read.push(k);
        await wait;
        return null;
      },
      set: async () => {},
    },
    request: async () => tencent(),
  });
  const result = s.handle({
    action: "quotes",
    assetIds: ["sh600519", "sz000001"],
  });
  await new Promise((resolve) => setImmediate(resolve));
  const count = read.length;
  release();
  await result;
  assert.equal(count, 2);
});
test("candle adapters trim provider history to requested calendar period", () => {
  const a = m.stockAsset("SH", "600519");
  const rows = [
    ["2020-01-01", "100", "100", "100", "100", "1"],
    ["2026-10-26", "1490", "1500", "1502", "1488", "4"],
  ];
  assert.equal(
    m.parseTencentChart({ data: { sh600519: { day: rows } } }, a, "1mo", NOW)
      .candles.length,
    1,
  );
  assert.equal(
    m.parseEastmoneyChart(
      { data: { code: "600519", klines: rows.map((row) => row.join(",")) } },
      a,
      "1mo",
      NOW,
    ).candles.length,
    1,
  );
});
test("search validates independent Tencent provider when primary response is unrelated JSONP", async () => {
  const calls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      calls.push(url);
      if (url.includes("searchapi."))
        return 'callback({"result":{"passportWeb":[]}})';
      return String.raw`v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A"`;
    },
  });
  const r = await s.handle({ action: "search", keyword: "600519" });
  assert.equal(r.ok, true);
  assert.equal(r.assets[0].name, "贵州茅台");
  assert.equal(calls.length, 2);
  assert.ok(calls[1].includes("smartbox.gtimg.cn"));
});
test("canonical IDs reject object prototype keys and non-string input", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => {
      throw Error("must not fetch");
    },
  });
  for (const assetId of [
    "__proto__",
    "constructor",
    "toString",
    {},
    null,
    600519,
  ]) {
    assert.throws(() => m.canonical(assetId));
    assert.equal((await s.handle({ action: "resolve", assetId })).ok, false);
  }
});
test("expired quote cache cannot masquerade as an available price", async () => {
  const stale = {
    assetId: "sh600519",
    price: 1500,
    sourceTime: NOW - 8 * 86400000,
    fetchedAt: NOW - 8 * 86400000,
  };
  const s = m.createService({
    now: () => NOW,
    store: memory({ "quoteCache:sh600519": stale }),
    request: async () => {
      throw Error("offline");
    },
  });
  assert.equal(
    (await s.handle({ action: "quote", assetId: "sh600519" })).ok,
    false,
  );
});
test("Tencent smartbox safely decodes Unicode and excludes funds, B shares and Hong Kong", () => {
  const body = String.raw`v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A^sz~000001~\u5e73\u5b89\u94f6\u884c~payh~GP-A^hk~00700~Tencent~tx~GP-A^sh~600520~Fund~f~JJ^sh~900901~B~b~GP-B";`;
  const assets = m.parseTencentSearch(body);
  assert.deepEqual(
    assets.map((a) => a.id),
    ["sh600519", "sz000001"],
  );
  assert.equal(assets[0].name, "贵州茅台");
  assert.throws(() => m.parseTencentSearch('v_hint="";process.exit()'));
});
test("Tencent independent fallback makes live-shaped searches and resolve work after invalid Eastmoney", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) =>
      url.includes("smartbox.gtimg.cn")
        ? String.raw`v_hint="sh~600519~\u8d35\u5dde\u8305\u53f0~gzmt~GP-A"`
        : "callback({})",
  });
  const r = await s.handle({ action: "search", keyword: "茅" });
  assert.equal(r.ok, true);
  assert.equal(r.source, "tencent");
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "sh600519" })).asset.name,
    "贵州茅台",
  );
});
test("gold fallback chooses the newest validated source time instead of regressing a delayed primary", async () => {
  const primary = em("AU9999");
  primary.data.f86 = (NOW - 3600000) / 1000;
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) =>
      url.includes("/stock/get")
        ? primary
        : {
            data: {
              code: "AU9999",
              trends: ["2026-10-26 15:30,900,901,902,899,3,2700,900"],
            },
          },
  });
  const r = await s.handle({ action: "quote", assetId: "gold-au9999" });
  assert.equal(r.quote.sourceTime, NOW - 3600000);
  assert.equal(r.quote.source, "eastmoney");
});
test("client falls back to read-only gold only when cloud cannot connect, never inventing source time", async () => {
  const client = require("../utils/market-client"),
    gold = require("../utils/gold-api");
  const original = gold.getAuQuote;
  const previousWx = global.wx;
  let reads = 0;
  global.wx = {
    cloud: {
      callFunction: async () => {
        throw Error("FUNCTION_NOT_FOUND");
      },
    },
  };
  gold.getAuQuote = async () => {
    reads++;
    return {
      price: 900,
      prevClose: 890,
      change: 10,
      changePct: 1.12,
      ts: Date.now(),
      source: "东方财富",
    };
  };
  try {
    const r = await client.quote("gold-au9999");
    assert.equal(r.quote.price, 900);
    assert.equal(r.quote.sourceTime, null);
    assert.equal(r.quote.status, "delayed");
    assert.equal(r.quote.stale, false);
    assert.match(r.quote.source, /本地回退/);
    assert.equal((await client.resolve("gold-xauusd")).asset.secid, "122.XAU");
    const batch = await client.quotes(["gold-au9999", "sh600519"]);
    assert.equal(batch.quotes.length, 1);
    assert.equal(batch.errors[0].assetId, "sh600519");
    await assert.rejects(client.quote("sh600519"), /行情服务/);
    assert.equal(reads, 2);
    global.wx.cloud.callFunction = async () => ({
      result: { ok: false, err: "unknown-asset", hint: "未知资产" },
    });
    await assert.rejects(client.quote("gold-au9999"), /未知资产/);
    assert.equal(reads, 2);
  } finally {
    gold.getAuQuote = original;
    global.wx = previousWx;
  }
});
test("client reports original cloud failure before compatibility fallback can hide it", async () => {
  const client = require("../utils/market-client");
  const previousWx = global.wx, previousWarn = console.warn;
  const cause = { errCode: -504003, errMsg: "cloud.callFunction:fail function execution timeout" };
  const warnings = [];
  global.wx = { cloud: { callFunction: async () => { throw cause; } } };
  console.warn = (...args) => warnings.push(args);
  try {
    // Resolving gold needs no provider request even when the cloud fails.
    const result = await client.resolve("gold-au9999");
    assert.equal(result.asset.id, "gold-au9999");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0][0], "[marketData] 云函数调用失败");
    assert.deepEqual(warnings[0][1], {
      action: "resolve", errCode: cause.errCode, errMsg: cause.errMsg,
    });
    await assert.rejects(client.callMarket("quote", { assetId: "gold-au9999" }), error => {
      assert.equal(error.cause, cause);
      return error.code === "market-cloud-connection-failed";
    });
  } finally {
    global.wx = previousWx;
    console.warn = previousWarn;
  }
});
test("local gold charts preserve bar dates and do not treat receipt time as source time", async () => {
  const client = require("../utils/market-client"),
    gold = require("../utils/gold-api");
  const oldAu = gold.getAuIntraday,
    oldXau = gold.getXauKline,
    previousWx = global.wx;
  global.wx = {
    cloud: {
      callFunction: async () => {
        throw Error("FUNCTION_NOT_FOUND");
      },
    },
  };
  gold.getAuIntraday = async () => ({
    points: [{ time: "10-26 21:00", price: 900, avg: 899, v: 1 }],
    prevClose: 890,
    source: "东方财富",
  });
  gold.getXauKline = async () => [
    { time: "2026-10-26", o: 4000, h: 4010, l: 3990, c: 4005, v: 1 },
  ];
  try {
    const i = await client.chart("gold-au9999", "intraday");
    assert.equal(i.chart.points[0].time, "10-26 21:00");
    assert.equal(i.chart.sourceTime, null);
    assert.equal(i.chart.stale, true);
    const c = await client.chart("gold-xauusd", "1mo");
    assert.equal(c.chart.candles[0].time, "2026-10-26");
    assert.equal(c.chart.sourceTime, Date.parse("2026-10-26T00:00:00+08:00"));
    await assert.rejects(client.chart("sh600519", "1mo"), /行情服务/);
  } finally {
    gold.getAuIntraday = oldAu;
    gold.getXauKline = oldXau;
    global.wx = previousWx;
  }
});
function sinaFixtures() {
  const stock = Array(34).fill("0");
  Object.assign(stock, {
    0: "贵州茅台",
    1: "1498",
    2: "1490",
    3: "1500.20",
    4: "1502",
    5: "1495",
    8: "12300",
    9: "1000000",
    30: "2026-10-27",
    31: "10:30:00",
  });
  const bank = [...stock];
  bank[0] = "平安银行";
  bank[3] = "11.47";
  return (
    'var hq_str_hf_XAU="4004.41,4016.970,4004.41,4004.76,4025.31,3997.27,10:30:00,4016.97,4018.34,0,0,0,2026-10-27,伦敦金（现货黄金）";\n' +
    'var hq_str_SGE_AU9999="AU9999,沪 金99,Au99.99,860.40,861.46,861.41,864.00,868.00,858.00,862.00,860.20,860.40,1.00,2.00,770744.00,663976320000.00,2026-10-27 10:30:00,-0.19%";\n' +
    `var hq_str_sh600519="${stock.join(",")}";\nvar hq_str_sz000001="${bank.join(",")}";`
  );
}
test("Sina adapters verify exact variable and preserve verified quote fields and provider times", () => {
  const assets = [
    m.canonical("gold-au9999"),
    m.canonical("gold-xauusd"),
    m.stockAsset("SH", "600519"),
  ];
  const rows = m.parseSinaQuotes(sinaFixtures(), assets, NOW);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].price, 860.4);
  assert.equal(rows[0].sourceTime, NOW);
  assert.equal(rows[0].prevClose, null);
  assert.equal(rows[0].changePct, -0.19);
  assert.equal(rows[0].volume, null);
  assert.equal(rows[1].prevClose, 4016.97);
  assert.equal(rows[1].open, 4018.34);
  assert.equal(rows[2].price, 1500.2);
  assert.equal(rows[2].prevClose, 1490);
  assert.deepEqual(
    m.parseSinaQuotes(
      sinaFixtures().replace("hq_str_sh600519", "hq_str_sh600520"),
      [assets[2]],
      NOW,
    ),
    [],
  );
  const bad = sinaFixtures().replace(
    "2026-10-27 10:30:00",
    "2026-10-26 10:30:00",
  );
  assert.equal(m.parseSinaQuotes(bad, [assets[0]], NOW)[0].status, "delayed");
});
test("Sina independently serves all four assets when Tencent and Eastmoney quotes fail", async () => {
  const calls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      calls.push(url);
      if (url.includes("hq.sinajs.cn")) return sinaFixtures();
      throw Error("socket hang up");
    },
  });
  const r = await s.handle({
    action: "quotes",
    assetIds: ["gold-au9999", "gold-xauusd", "sh600519", "sz000001"],
  });
  assert.equal(r.quotes.length, 4);
  assert.equal(r.errors.length, 0);
  assert.ok(r.quotes.every((q) => q.source === "sina" && q.sourceTime === NOW));
  assert.equal(
    calls.filter((url) => url.includes("hq.sinajs.cn/list=sh600519,sz000001"))
      .length,
    1,
  );
});
test("market transport supplies mandatory exact-host Referer headers for Sina and SGE", async () => {
  const https = require("https"),
    { EventEmitter } = require("events"),
    original = https.get,
    seen = [];
  https.get = (url, options, callback) => {
    seen.push([url, options.headers]);
    const req = new EventEmitter();
    req.setTimeout = () => {};
    const res = new EventEmitter();
    res.statusCode = 200;
    callback(res);
    setImmediate(() => {
      res.emit("data", Buffer.from("ok"));
      res.emit("end");
    });
    return req;
  };
  try {
    await m.request("https://hq.sinajs.cn/list=hf_XAU");
    await m.request("https://stock2.finance.sina.com.cn/history");
    await m.request("https://www.sge.com.cn/graph/Dailyhq?instid=Au99.99");
    assert.equal(seen[0][1].Referer, "https://finance.sina.com.cn/");
    assert.equal(seen[1][1].Referer, "https://finance.sina.com.cn/");
    assert.equal(seen[2][1].Referer, "https://www.sge.com.cn/");
  } finally {
    https.get = original;
  }
});
test("gold daily charts use independently verified SGE and Sina history after Eastmoney fails", async () => {
  const urls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      urls.push(url);
      if (url.includes("www.sge.com.cn/graph/Dailyhq?instid=Au99.99"))
        return { time: [["2026-10-26", 865, 861.41, 855, 872.99]] };
      if (
        url.includes(
          "GlobalFuturesService.getGlobalFuturesDailyKLine?symbol=XAU",
        )
      )
        return 'var _daily=([{"date":"2026-10-26","open":"4000","close":"4010","high":"4020","low":"3990","volume":"0"}]);';
      throw Error("socket hang up");
    },
  });
  const au = await s.handle({
      action: "chart",
      assetId: "gold-au9999",
      period: "1mo",
    }),
    xau = await s.handle({
      action: "chart",
      assetId: "gold-xauusd",
      period: "1mo",
    });
  assert.equal(au.ok, true);
  assert.equal(au.chart.source, "sge");
  assert.equal(au.chart.candles[0].c, 861.41);
  assert.equal(xau.ok, true);
  assert.equal(xau.chart.source, "sina");
  assert.equal(xau.chart.candles[0].c, 4010);
  assert.equal(urls.length, 4);
});
test("gold intraday uses independent SGE and Sina routes when Eastmoney is unavailable", async () => {
  const calls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      calls.push(url);
      if (url.includes("www.sge.com.cn/graph/quotations?instid=Au99.99"))
        return {
          times: ["09:00", "10:30", "11:00"],
          data: ["900", "901", "902"],
          heyue: "Au99.99",
          now: "10:30",
          delaystr: "2026年10月27日 10:30:00",
        };
      if (
        url.includes("GlobalFuturesService.getGlobalFuturesMinLine?symbol=XAU")
      )
        return 'var _min=({"minLine_1d":[["2026-10-27","4016.970","LIFFE","","06:00","4017.030","0","","4017.087","2026-10-27 06:00:00"]]});';
      throw Error("socket hang up");
    },
  });
  const au = await s.handle({
      action: "chart",
      assetId: "gold-au9999",
      period: "intraday",
    }),
    xau = await s.handle({
      action: "chart",
      assetId: "gold-xauusd",
      period: "intraday",
    });
  assert.equal(au.ok, true);
  assert.equal(au.chart.source, "sge");
  assert.equal(au.chart.points.length, 2);
  assert.equal(au.chart.points[1].price, 901);
  assert.equal(xau.ok, true);
  assert.equal(xau.chart.source, "sina");
  assert.equal(xau.chart.points[0].price, 4017.03);
  assert.equal(calls.length, 4);
});
