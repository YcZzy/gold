const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const m = require("../cloudfunctions/marketData");
const fx = (name) =>
  fs.readFileSync(path.join(__dirname, "fixtures/markets", name), "utf8");
const NOW = Date.parse("2026-10-28T09:00:00Z");
const memory = (initial = {}) => {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (c, k) => map.get(c + ":" + k),
    set: async (c, k, v) => map.set(c + ":" + k, v),
    search: async () => [],
  };
};
const us = () =>
  JSON.parse(fx("quote-us-identity-samples-2026-10-28.json"))
    .samples.map((s) => s.raw)
    .join("\n");
test("canonical metadata supports exact official BJ and HK counters and CN ETFs", () => {
  for (const [id, market, kind, currency] of [
    ["bj920185", "BJ", "stock", "CNY"],
    ["hk00700", "HK", "stock", "HKD"],
    ["hk80700", "HK", "stock", "CNY"],
    ["hk02800", "HK", "etf", "HKD"],
    ["sh510300", "SH", "etf", "CNY"],
    ["sz159915", "SZ", "etf", "CNY"],
  ]) {
    const a = m.canonical(id);
    assert.equal(a.market, market);
    assert.equal(a.kind, kind);
    assert.equal(a.currency, currency);
    assert.equal(a.supportsClose, true);
    assert.ok(a.timezone);
    assert.ok(a.providers.tencentChart);
    assert.ok(a.secid);
  }
  for (const id of [
    "bj920999",
    "hk07200",
    "hk00405",
    "hk13005",
    "hk99999",
    "sh503001",
    "sz150001",
    "usTCEHY.PS",
    "usAAPL&x=1",
  ])
    assert.throws(() => m.canonical(id));
});
test('CN daily charts use independently verified raw Sina history when Tencent and Eastmoney fail',async()=>{
  const s=m.createService({now:()=>NOW,store:memory(),request:async url=>{
    if(url.includes('CN_MarketDataService.getKLineData'))return fx('charts-raw-sina-sh600519-day.json');
    throw Error('HTTP 501');
  }});
  const r=await s.handle({action:'chart',assetId:'sh600519',period:'5y'});
  assert.equal(r.ok,true,r.hint);assert.equal(r.chart.source,'sina');
  assert.ok(r.chart.candles.length>1200);assert.equal(r.chart.coverage.status,'complete');
});
test('independent CN minute fallback keeps only the latest real trade date',async()=>{
  const s=m.createService({now:()=>Date.parse('2026-10-29T02:30Z'),store:memory(),request:async url=>{
    if(url.includes('CN_MarketDataService.getKLineData')&&url.includes('scale=1&'))return fx('charts-raw-sina-sz300750-minute.json');
    throw Error('HTTP 501');
  }});
  const r=await s.handle({action:'chart',assetId:'sz300750',period:'intraday'});
  assert.equal(r.ok,true,r.hint);assert.equal(r.chart.source,'sina');
  assert.ok(r.chart.points.length>20);assert.ok(r.chart.points.every(p=>p.time.startsWith('2026-10-29 ')));
  assert.equal(r.chart.sourceTime,Date.parse('2026-10-29T09:57:00+08:00'));
});
test("US canonical identities preserve provider symbol suffix separately", () => {
  for (const [id, chart, kind] of [
    ["usAAPL", "usAAPL.OQ", "stock"],
    ["usSPY", "usSPY.AM", "etf"],
    ["usBRK.B", "usBRK.B.N", "stock"],
  ]) {
    const a = m.canonical(id);
    assert.equal(a.quoteCode, id);
    assert.equal(a.providers.tencentChart, chart);
    assert.equal(a.kind, kind);
    assert.equal(a.timezone, "America/New_York");
  }
});
test("Tencent quote identity validates US exchange, type, currency, and escaped dot", () => {
  const a = m.canonical("usBRK.B");
  const q = m.parseTencentQuotes(us(), [a], NOW)[0];
  assert.equal(q.price, 542.99);
  assert.equal(q.sourceTime, Date.parse("2026-10-27T20:06:36Z"));
  assert.equal(q.amount, 1677201395);
  assert.equal(q.volumeUnit, null);
  assert.equal(q.sessionDate, "2026-10-27");
  assert.equal(
    m.parseTencentQuotes(us().replace("v_usBRK.B=", "v_usBRKxB="), [a], NOW)
      .length,
    0,
  );
  assert.equal(
    m.parseTencentQuotes(us().replace("BRK.B.N~", "BRK.B.PS~"), [a], NOW)
      .length,
    0,
  );
  assert.equal(
    m.parseTencentQuotes(us().replace("~USD~", "~HKD~"), [a], NOW).length,
    0,
  );
});
test("Tencent HK exact directory classification and currency reject excluded securities", () => {
  const body = fx("quotes-tencent.txt");
  const a = m.canonical("hk00700");
  const q = m.parseTencentQuotes(body, [a], NOW)[0];
  assert.ok(q);
  assert.equal(
    q.amount,
    Number(/v_r_hk00700="([^"]*)"/.exec(body)[1].split("~")[37]),
  );
  const delay = m.parseTencentQuotes(
    body.replace(/v_r_hk00700=/g, "v_hk00700="),
    [{ ...a, quoteCode: "hk00700" }],
    NOW,
  )[0];
  assert.equal(delay.status, "delayed");
  assert.equal(
    m.parseTencentQuotes(body.replace(/~HKD~/g, "~USD~"), [a], NOW).length,
    0,
  );
});
test("US timestamp parsing observes New York DST", () => {
  const a = m.canonical("usAAPL");
  for (const [civil, iso] of [
    ["2026-07-01 10:00:00", "2026-07-01T14:00:00Z"],
    ["2026-01-05 10:00:00", "2026-01-05T15:00:00Z"],
  ]) {
    const raw = us().replace("2026-10-27 16:00:01", civil);
    assert.equal(
      m.parseTencentQuotes(raw, [a], NOW)[0].sourceTime,
      Date.parse(iso),
    );
  }
});
test("raw US intraday uses full identity and New York labels", () => {
  const c = m.parseTencentChart(
    fx("charts-raw-tencent-us-minute.json"),
    m.canonical("usAAPL"),
    "intraday",
    NOW,
  );
  assert.equal(c.points.length, 391);
  assert.equal(c.points[0].time, "2026-10-27 09:30");
  assert.equal(c.sourceTime, Date.parse("2026-10-27T20:00:00Z"));
  assert.equal(c.volumeUnit, null);
  assert.throws(() =>
    m.parseTencentChart(
      { data: { "usAAPL.OQ": { data: { data: ["0930 10 3"] } } } },
      m.canonical("usAAPL"),
      "intraday",
      NOW,
    ),
  );
});
test("Eastmoney US minute converts Beijing full datetime to exchange-local day", () => {
  const c = m.parseEastmoneyChart(
    fx("charts-raw-eastmoney-us-minute.json"),
    m.canonical("usAAPL"),
    "intraday",
    NOW,
  );
  assert.equal(c.points[0].time, "2026-10-27 09:31");
  assert.equal(c.points.at(-1).time, "2026-10-27 16:00");
  assert.equal(c.sourceTime, Date.parse("2026-10-27T20:00:00Z"));
});
test("raw US and HK daily history supports every daily period and rejects extreme OHLC anomalies", () => {
  for (const period of ["1mo", "3mo", "1y", "5y"]) {
    const c = m.parseTencentChart(
      fx("charts-raw-tencent-us-day.json"),
      m.canonical("usAAPL"),
      period,
      NOW,
    );
    assert.ok(c.candles.length);
  }
  const raw = {
    data: { code: "SPY", klines: ["2026-10-27,767,769,771,69,123"] },
  };
  assert.throws(() =>
    m.parseEastmoneyChart(raw, m.canonical("usSPY"), "1mo", NOW),
  );
});
test("search merges complete official directory including BJ Chinese and English names offline", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => {
      throw Error("offline");
    },
  });
  for (const keyword of ["920185", "贝特瑞", "BTR"]) {
    const r = await s.handle({ action: "search", keyword });
    assert.equal(r.ok, true);
    assert.ok(r.assets.some((a) => a.id === "bj920185"));
  }
  const r = await s.handle({ action: "search", keyword: "80700" });
  assert.equal(r.assets[0].currency, "CNY");
});
test("search confirms Tencent GP US result with quote metadata identifying ETF", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("searchapi")) throw Error("offline");
      if (url.includes("smartbox")) return fx("search-tencent-spy.txt");
      if (url.includes("qt.gtimg")) return us();
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "search", keyword: "SPY" });
  assert.equal(r.ok, true);
  assert.equal(r.assets.find((a) => a.id === "usSPY").kind, "etf");
});
test("ETF is included in quote batch, and CN non ETF metadata cannot impersonate ETF", async () => {
  const raw = fx("quotes-tencent.txt");
  const a = m.canonical("sh510300");
  assert.ok(m.parseTencentQuotes(raw, [a], NOW)[0]);
  assert.equal(
    m.parseTencentQuotes(raw.replace(/~ETF~/g, "~LOF~"), [a], NOW).length,
    0,
  );
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("qt.gtimg")) return raw;
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "quotes",
    assetIds: ["sh510300", "sz159915", "hk02800", "usSPY"],
  });
  assert.ok(r.quotes.some((q) => q.assetId === "sh510300"));
});
test("US chart uses usMinute and raw full-symbol daily route, preserving stale source time on failure", async () => {
  const store = memory();
  const urls = [];
  const s = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      urls.push(url);
      if (url.includes("usMinute"))
        return fx("charts-raw-tencent-us-minute.json");
      if (url.includes("fqkline")) return fx("charts-raw-tencent-us-day.json");
      if (url.includes("klt=101"))
        return fx("charts-raw-eastmoney-us-day.json");
      throw Error("offline");
    },
  });
  for (const period of ["intraday", "1mo", "3mo", "1y", "5y"]) {
    const r = await s.handle({ action: "chart", assetId: "usAAPL", period });
    assert.equal(r.ok, true, r.hint);
  }
  assert.ok(urls.some((u) => u.includes("usMinute/query?code=usAAPL.OQ")));
  assert.ok(urls.some((u) => u.includes("usAAPL.OQ,day,,,1500,")));
  const offline = m.createService({
    now: () => NOW + 120000,
    store,
    request: async () => {
      throw Error("offline");
    },
  });
  const c = await offline.handle({
    action: "chart",
    assetId: "usAAPL",
    period: "intraday",
  });
  assert.equal(c.chart.stale, true);
  assert.equal(c.chart.sourceTime, Date.parse("2026-10-27T20:00:00Z"));
});
test("BJ daily fallback uses verified current identity Sina series with safe JSON only", async () => {
  const urls = [];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      urls.push(url);
      if (url.includes("CN_MarketDataService"))
        return JSON.parse(
          fx("charts-raw-eastmoney-bj-day.json"),
        ).data.klines.map((line) => {
          const [day, open, close, high, low, volume] = line.split(",");
          return { day, open, close, high, low, volume };
        });
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "chart",
    assetId: "bj920185",
    period: "5y",
  });
  assert.equal(r.ok, true, r.hint);
  assert.ok(r.chart.candles.length);
  assert.ok(
    urls.some(
      (u) => u.includes("symbol=bj920185") && u.includes("datalen=1500"),
    ),
  );
  assert.ok(urls.every((u) => !u.includes("nq835185")));
});
test("US search falls back when Eastmoney succeeds but contains only unsupported result types", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("searchapi"))
        return {
          QuotationCodeTable: {
            Data: [{ Code: "AAPL", Name: "苹果", SecurityTypeName: "美股" }],
          },
        };
      if (url.includes("smartbox")) return fx("search-tencent-aapl.txt");
      if (url.includes("qt.gtimg")) return us();
      throw Error("offline");
    },
  });
  assert.equal(
    (await s.handle({ action: "resolve", assetId: "usAAPL" })).ok,
    true,
  );
});
test("search and resolve support other main-exchange US symbols only after exact identity verification", async () => {
  const raw = us().replace(/AAPL/g, "MSFT").replace(/苹果/g, "微软");
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("smartbox"))
        return 'v_hint="us~msft.oq~Microsoft~msft~GP";';
      if (url.includes("qt.gtimg")) return raw;
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "resolve", assetId: "usMSFT" });
  assert.equal(r.ok, true);
  assert.equal(r.asset.secid, "us:MSFT");
  assert.equal(r.asset.providers.tencentChart, "usMSFT.OQ");
  assert.equal(r.asset.providers.eastmoney, undefined);
});
test("ETF rejected by Tencent identity cannot be accepted by an untyped fallback quote", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("qt.gtimg"))
        return fx("quotes-tencent.txt").replace(/~ETF~/g, "~LOF~");
      if (url.includes("stock/get"))
        return { data: { f57: "510300", f59: 3, f43: 4152, f86: NOW / 1000 } };
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "quote", assetId: "sh510300" });
  assert.equal(r.ok, false);
});
test("versioned search does not reuse earlier empty cache results for BJ exact codes", async () => {
  const key = Buffer.from("920185").toString("hex");
  const store = memory({
    ["searchCache:" + key]: { assets: [], fetchedAt: NOW },
  });
  const s = m.createService({
    now: () => NOW,
    store,
    request: async () => {
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "search", keyword: "920185" });
  assert.ok(r.assets.some((a) => a.id === "bj920185"));
});
test("Sina HK backup uses rt_hk symbol, Hong Kong timestamp, original-currency turnover", () => {
  const p = Array(20).fill("");
  Object.assign(p, {
    0: "TENCENT",
    1: "腾讯控股",
    2: "380",
    3: "379",
    4: "390",
    5: "378",
    6: "387.6",
    11: "5304563678.109",
    17: "2026/10/28",
    18: "16:08:30",
  });
  const q = m.parseSinaQuotes(
    'var hq_str_rt_hk00700="' + p.join(",") + '";',
    [m.canonical("hk00700")],
    NOW,
  )[0];
  assert.equal(q.price, 387.6);
  assert.equal(q.amount, 5304563678.109);
  assert.equal(q.sourceTime, Date.parse("2026-10-28T08:08:30Z"));
});
test("catalog refresh reproduces complete validated deployment directories atomically from official snapshots", () => {
  const os = require("node:os"),
    cp = require("node:child_process");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "market-catalog-"));
  const output = path.join(dir, "catalog.json");
  try {
    const r = cp.spawnSync(
      "python3",
      [
        path.join(__dirname, "../scripts/update-market-catalog.py"),
        "--fixtures",
        path.join(__dirname, "fixtures/markets"),
        "--output",
        output,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    const c = JSON.parse(fs.readFileSync(output));
    assert.equal(c.records.filter((r) => r.market === "BJ").length, 353);
    assert.equal(c.records.filter((r) => r.market === "HK").length, 3209);
    assert.ok(
      c.records.some((r) => r.symbol === "82840" && r.currency === "CNY"),
    );
    assert.ok(
      !c.records.some(
        (r) => r.market === "HK" && ["00405", "07200"].includes(r.symbol),
      ),
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("live BSE pagination parser retains official English search names and rejects incomplete refresh", () => {
  const cp = require("node:child_process");
  const script = path.join(__dirname, "../scripts/update-market-catalog.py"),
    fixture = path.join(
      __dirname,
      "fixtures/markets/bj-directory-raw-pages-2026-10-28.json",
    );
  const code =
    'import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location("catalog",sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\npages=json.load(open(sys.argv[2]));rows=m.bse_records(pages);assert next(r for r in rows if r["symbol"]=="920185")["englishName"]=="BTR"\ntry: m.bse_records(pages[:-1])\nexcept ValueError: pass\nelse: raise AssertionError("partial catalog accepted")';
  const r = cp.spawnSync("python3", ["-B", "-c", code, script, fixture], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stderr);
});
test("ETF quote batch transport failure retries exact symbol to establish identity before fallback", async () => {
  let requests = 0;
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("qt.gtimg")) {
        requests++;
        if (requests === 1) throw Error("transient batch failure");
        return fx("quotes-tencent.txt");
      }
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "quotes",
    assetIds: ["sh510300", "sz159915"],
  });
  assert.equal(r.quotes.length, 2);
  assert.equal(r.errors.length, 0);
});
test("quote exposes exchange session state and unknown calendar years disable close support", async () => {
  const raw = fx("quotes-tencent.txt");
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async () => raw,
  });
  const r = await s.handle({ action: "quote", assetId: "sh510300" });
  assert.equal(r.quote.marketState, "closed");
  assert.equal(r.quote.sessionDate, "2026-10-28");
  const future = m.createService({
    now: () => Date.parse("2030-01-03T02:00:00Z"),
    store: memory(),
    request: async () => raw,
  });
  const unknown = await future.handle({ action: "quote", assetId: "sh510300" });
  assert.equal(unknown.asset.supportsClose, false);
  assert.equal(unknown.quote.marketState, "unknown");
});
test("verified provider decimals persist on assets through resolve without rounding prices", async () => {
  const raw = us().replace("~347.10~", "~0.1234~");
  const store = memory();
  const s = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      if (url.includes("qt.gtimg")) return raw;
      throw Error("offline");
    },
  });
  const q = await s.handle({ action: "quote", assetId: "usAAPL" });
  assert.equal(q.asset.precision, 4);
  assert.equal(q.quote.price, 0.1234);
  const r = await s.handle({ action: "resolve", assetId: "usAAPL" });
  assert.equal(r.asset.precision, 4);
  assert.equal(r.asset.providers.tencentIdentity, "AAPL.OQ");
  assert.equal(m.canonical("hk02800").precision, 3);
});
test("Chinese ETF search falls back from an empty valid Eastmoney response", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("searchapi"))
        return { QuotationCodeTable: { Data: [] } };
      if (url.includes("smartbox"))
        return 'v_hint="sh~510300~沪深300ETF华泰柏瑞~hs300~ETF";';
      if (url.includes("qt.gtimg")) return fx("quotes-tencent.txt");
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "search", keyword: "沪深300ETF" });
  assert.ok(r.assets.some((a) => a.id === "sh510300"));
});
test("offline catalog fallback restores validated non-hardcoded US identities and unknown-year support", async () => {
  const asset = {
    id: "usMSFT",
    name: "微软",
    market: "US",
    code: "MSFT",
    kind: "stock",
    precision: 4,
    providers: { tencentIdentity: "MSFT.OQ" },
  };
  const store = { ...memory(), search: async () => [{ asset }] };
  const s = m.createService({
    now: () => Date.parse("2030-01-03T02:00:00Z"),
    store,
    request: async () => {
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "search", keyword: "微软" });
  assert.equal(r.ok, true);
  assert.equal(r.assets[0].id, "usMSFT");
  assert.equal(r.assets[0].precision, 4);
  assert.equal(r.assets[0].providers.tencentChart, "usMSFT.OQ");
  assert.equal(r.assets[0].supportsClose, false);
});
test("chart embedded quote identity must agree with full requested US exchange identity", () => {
  const raw = JSON.parse(fx("charts-raw-tencent-us-day.json"));
  raw.data["usAAPL.OQ"].qt["usAAPL.OQ"][2] = "AAPL.PS";
  assert.throws(() =>
    m.parseTencentChart(raw, m.canonical("usAAPL"), "1mo", NOW),
  );
});
test("US intraday reaches independent minute-K fallback after all Tencent transports fail", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("klt=1"))
        return fx("charts-raw-eastmoney-us-minute.json");
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "chart",
    assetId: "usAAPL",
    period: "intraday",
  });
  assert.equal(r.ok, true);
  assert.equal(r.chart.source, "eastmoney");
  assert.equal(r.chart.points[0].time, "2026-10-27 09:31");
  assert.equal(r.chart.volumeUnit, null);
});

test("search unions valid Eastmoney CN and Tencent US matches for the same keyword", async () => {
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("searchapi"))
        return {
          QuotationCodeTable: {
            Data: [
              {
                Code: "600519",
                Name: "跨市场",
                MktNum: "1",
                SecurityTypeName: "沪A",
              },
            ],
          },
        };
      if (url.includes("smartbox")) return fx("search-tencent-aapl.txt");
      if (url.includes("qt.gtimg")) return us();
      throw Error("offline");
    },
  });
  const r = await s.handle({ action: "search", keyword: "跨市场" });
  assert.deepEqual(
    new Set(r.assets.map((a) => a.id)),
    new Set(["sh600519", "usAAPL"]),
  );
});
test("server quote and chart outage fallbacks explicitly mark cached while retaining timestamps", async () => {
  const store = memory();
  const s = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      if (url.includes("qt.gtimg")) return us();
      if (url.includes("usMinute"))
        return fx("charts-raw-tencent-us-minute.json");
      throw Error("offline");
    },
  });
  const q = await s.handle({ action: "quote", assetId: "usAAPL" });
  const c = await s.handle({
    action: "chart",
    assetId: "usAAPL",
    period: "intraday",
  });
  const offline = m.createService({
    now: () => NOW + 120000,
    store,
    request: async () => {
      throw Error("offline");
    },
  });
  const q2 = await offline.handle({ action: "quote", assetId: "usAAPL" });
  const c2 = await offline.handle({
    action: "chart",
    assetId: "usAAPL",
    period: "intraday",
  });
  for (const [before, after] of [
    [q.quote, q2.quote],
    [c.chart, c2.chart],
  ]) {
    assert.equal(after.cached, true);
    assert.equal(after.stale, true);
    assert.equal(after.sourceTime, before.sourceTime);
    assert.equal(after.fetchedAt, before.fetchedAt);
  }
});
test("persisted exact ETF type verification permits independent Sina quote during Tencent outage", async () => {
  const store = memory();
  const online = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      if (url.includes("searchapi"))
        return { QuotationCodeTable: { Data: [] } };
      if (url.includes("smartbox"))
        return 'v_hint="sh~510300~沪深300ETF华泰柏瑞~hs300~ETF";';
      if (url.includes("qt.gtimg")) return fx("quotes-tencent.txt");
      throw Error("offline");
    },
  });
  const found = await online.handle({ action: "search", keyword: "510300" });
  assert.equal(found.assets[0].typeVerified, "tencent");
  const p = Array(33).fill("");
  Object.assign(p, {
    0: "沪深300ETF",
    1: "4.1",
    2: "4.12",
    3: "4.152",
    4: "4.166",
    5: "4.132",
    30: "2026-10-28",
    31: "16:08:00",
  });
  const offline = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      if (url.includes("hq.sinajs"))
        return 'var hq_str_sh510300="' + p.join(",") + '";';
      throw Error("Tencent unavailable");
    },
  });
  const q = await offline.handle({ action: "quote", assetId: "sh510300" });
  assert.equal(q.ok, true, q.hint);
  assert.equal(q.quote.source, "sina");
  assert.equal(q.quote.stale, false);
});
test("known old AAPL truncated 5y response advances to complete independent history", async () => {
  const one = {
    data: {
      "usAAPL.OQ": { day: [["2026-10-27", "343", "347", "348", "342", "3"]] },
    },
  };
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("fqkline")) return one;
      if (url.includes("klt=101"))
        return fx("charts-raw-eastmoney-us-day.json");
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "chart",
    assetId: "usAAPL",
    period: "5y",
  });
  assert.equal(r.ok, true, r.hint);
  assert.equal(r.chart.source, "eastmoney");
  assert.ok(r.chart.candles.length > 1200);
  assert.equal(r.chart.coverage.status, "complete");
});
test("verified new HK currency counter returns its actual limited history range", async () => {
  const rows = [
    ["2024-10-29", "10", "11", "12", "9", "3"],
    ["2026-10-28", "11", "12", "13", "10", "4"],
  ];
  const s = m.createService({
    now: () => NOW,
    store: memory(),
    request: async (url) => {
      if (url.includes("fqkline")) return { data: { hk82840: { day: rows } } };
      throw Error("offline");
    },
  });
  const r = await s.handle({
    action: "chart",
    assetId: "hk82840",
    period: "5y",
  });
  assert.equal(r.ok, true, r.hint);
  assert.equal(r.chart.coverage.status, "limited");
  assert.equal(r.chart.coverage.actualStart, "2024-10-29");
  assert.equal(r.chart.coverage.requestedStart, "2021-10-28");
  assert.equal(r.chart.coverage.verified, true);
});
test("validated main-exchange US identity receives independently checked Eastmoney mapping", async () => {
  const asset = {
    id: "usMSFT",
    name: "微软",
    market: "US",
    code: "MSFT",
    kind: "stock",
    precision: 2,
    identityVerified: "tencent",
    typeVerified: "tencent",
    providers: { tencentIdentity: "MSFT.OQ" },
  };
  const store = memory({ "instruments:usMSFT": { asset } });
  const day = JSON.parse(fx("charts-raw-eastmoney-us-day.json"));
  day.data.code = "MSFT";
  day.data.market = 105;
  day.data.name = "微软";
  const s = m.createService({
    now: () => NOW,
    store,
    request: async (url) => {
      if (url.includes("stock/get"))
        return {
          data: {
            f57: "MSFT",
            f58: "微软",
            f13: 105,
            f59: 2,
            f43: 50000,
            f86: NOW / 1000,
          },
        };
      if (url.includes("klt=101")) return day;
      throw Error("Tencent offline");
    },
  });
  const r = await s.handle({ action: "quote", assetId: "usMSFT" });
  assert.equal(r.ok, true, r.hint);
  assert.equal(r.asset.providers.eastmoney, "105.MSFT");
  assert.equal(r.asset.secid, "105.MSFT");
  assert.equal(r.quote.source, "eastmoney");
});
