const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
function load(file, clients = {}) {
  let page;
  const timers = new Map();
  let clock = 0;
  const routes = [];
  const wx = {
    getStorageSync: () => [],
    setStorageSync() {},
    navigateTo: (x) => routes.push(x.url),
    showToast() {},
    showModal: (x) => x.success({ confirm: true }),
    cloud: { callFunction: async () => ({ result: { ok: true } }) },
    stopPullDownRefresh() {},
    createSelectorQuery: () => ({
      selectAll() { return this; },
      boundingClientRect(callback) {
        this.callback = callback;
        return this;
      },
      exec() { this.callback(page.data.rows.map((_, i) => ({ top: i * 80, height: 80 }))); },
    }),
  };
  const theme = {
    getTheme: () => "paper",
    syncFromPrefs: (prefs) => (prefs && prefs.theme) || "paper",
    themeIcon: () => "",
    bellIcon: () => "",
    applyChrome() {},
    chartColors: () => ({}),
  };
  vm.runInNewContext(
    fs.readFileSync(path.join(__dirname, "..", file), "utf8"),
    {
      Page: (x) => (page = x),
      require: (p) =>
        p.includes("market-client")
          ? clients.market
          : p.includes("portfolio-client")
            ? clients.portfolio
            : p.includes("theme")
              ? theme
              : p.includes("gold-api")
                ? clients.gold
                : p.includes("asset-format")
                  ? require("../utils/asset-format")
                  : p.includes("candle-chart")
                    ? { createKlineChart() {} }
                    : require(
                        path.resolve(
                          path.dirname(path.join(__dirname, "..", file)),
                          p,
                        ),
                      ),
      wx,
      setTimeout: (f) => {
        timers.set(++clock, f);
        return clock;
      },
      clearTimeout: (i) => timers.delete(i),
      setInterval: (f) => {
        timers.set(++clock, f);
        return clock;
      },
      clearInterval: (i) => timers.delete(i),
      console,
      Date,
      Promise,
    },
  );
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = (patch) => Object.assign(page.data, patch);
  return { page, timers, routes, wx };
}
const a = {
  id: "sh600519",
  name: "贵州茅台",
  code: "600519",
  market: "SH",
  kind: "stock",
  unit: "元/股",
  precision: 2,
};
const state = {
  ok: true,
  items: [a],
  rules: [],
  limits: { watchlist: 5, activeRules: 30 },
  revision: 2,
};
test("watchlist retains quotes by asset while reload waits for fresh prices", async () => {
  const b = { ...a, id: "sz000001", name: "平安银行" };
  let finish;
  let response = { quotes: [{ assetId: a.id, price: 100, changePct: 2, sourceTime: 1000 }] };
  const { page } = load("pages/index/index.js", {
    portfolio: { list: async () => ({ ...state, items: [b, { ...a, name: "新名称" }] }) },
    market: { quotes: () => response || new Promise((r) => (finish = r)) },
  });
  await page.onShow();
  response = null;
  const refresh = page.onPullDownRefresh();
  await new Promise((r) => setImmediate(r));
  assert.equal(page.data.rows[1].priceText, "100.00");
  assert.equal(page.data.rows[1].pctText, "+2.00%");
  assert.equal(page.data.rows[1].name, "新名称");
  finish({ quotes: [{ assetId: a.id, price: 101, changePct: 3, sourceTime: 2000 }] });
  await refresh;
  assert.equal(page.data.rows[1].priceText, "101.00");
  page.onHide();
});
test("watchlist keeps last quote when refresh omits it or returns unavailable data", async () => {
  let response = { quotes: [{ assetId: a.id, price: 100, changePct: 2, sourceTime: 1000 }] };
  const { page } = load("pages/index/index.js", {
    portfolio: { list: async () => state },
    market: { quotes: async () => response },
  });
  await page.onShow();
  for (const quotes of [[], [{ assetId: a.id, price: null, status: "unavailable" }]]) {
    response = { quotes, errors: [{ hint: "行情暂不可用" }] };
    await page.loadQuotes();
    assert.equal(page.data.rows[0].priceText, "100.00");
    assert.equal(page.data.rows[0].pctText, "+2.00%");
    assert.equal(page.data.errorText, "");
  }
  page.onHide();
});
test("watchlist opens immutable asset route and stops quote polling while hidden", async () => {
  const { page, timers, routes } = load("pages/index/index.js", {
    portfolio: { list: async () => state },
    market: { quotes: async () => ({ quotes: [], errors: [] }) },
  });
  await page.onShow();
  assert.equal(page.data.rows[0].id, a.id);
  assert.equal(timers.size, 1);
  page.openDetail({ currentTarget: { dataset: { id: a.id } } });
  assert.match(routes[0], /assetId=sh600519/);
  page.onHide();
  assert.equal(timers.size, 0);
});
test("search ignores older responses and plus adds exact result without navigation", async () => {
  let finish;
  const adds = [];
  const { page, routes } = load("pages/search/search.js", {
    market: {
      search: (k) =>
        k === "old"
          ? new Promise((r) => (finish = r))
          : Promise.resolve({ assets: [a] }),
    },
    portfolio: {
      add: async (id) => {
        adds.push(id);
        return state;
      },
    },
  });
  page.onLoad();
  const old = page.runSearch("old");
  await page.runSearch("new");
  finish({ assets: [{ ...a, id: "wrong" }] });
  await old;
  assert.equal(page.data.results[0].id, a.id);
  await page.addAsset({ currentTarget: { dataset: { id: a.id } } });
  assert.deepEqual(adds, [a.id]);
  assert.equal(routes.length, 0);
});
test("rule editor stays asset scoped, does not save drafts and retains failed save", async () => {
  let saved;
  const { page } = load("pages/asset-alert/asset-alert.js", {
    market: { resolve: async () => ({ asset: a }) },
    portfolio: {
      list: async () => state,
      saveRule: async (r) => {
        saved = r;
        throw Error("额度已满");
      },
    },
  });
  page.onLoad({ assetId: a.id });
  await page.onShow();
  page.editRule({ currentTarget: { dataset: { type: "priceAbove" } } });
  page.onValue({ detail: { value: "123.45" } });
  assert.equal(saved, undefined);
  await page.saveRule();
  assert.equal(saved.assetId, a.id);
  assert.equal(saved.value, 123.45);
  assert.equal(page.data.errorText, "额度已满");
  assert.equal(page.data.editing, true);
});
test("detail ignores quote responses after page unload", async () => {
  let finish;
  const { page } = load("pages/detail/detail.js", {
    market: {
      resolve: async () => ({ asset: a }),
      quote: () => new Promise((r) => (finish = r)),
      chart: async () => ({ chart: { points: [] } }),
    },
    portfolio: { list: async () => state },
  });
  page.onLoad({ assetId: a.id });
  const request = page.loadQuote();
  page.onUnload();
  finish({ quote: { price: 100 } });
  await request;
  assert.equal(page.data.quote.priceText, "--");
});
test("watchlist reorder sends a complete permutation with server revision and keeps state on failure", async () => {
  const b = { ...a, id: "sz000001" };
  let received;
  const { page } = load("pages/index/index.js", {
    portfolio: {
      list: async () => ({ ...state, items: [a, b] }),
      reorder: async (ids, rev) => {
        received = { ids: Array.from(ids), rev };
        throw Error("自选已更新，请重试");
      },
    },
    market: { quotes: async () => ({ quotes: [] }) },
  });
  await page.onShow();
  page.toggleManage();
  page.startDrag({ currentTarget: { dataset: { id: b.id } }, touches: [{ clientY: 120 }] });
  page.dragMove({ touches: [{ clientY: 40 }] });
  assert.equal(page.data.rows[0].id, b.id);
  await page.endDrag();
  assert.deepEqual(received, { ids: [b.id, a.id], rev: 2 });
  assert.equal(page.data.rows[0].id, a.id);
  assert.match(page.data.errorText, /自选已更新/);
  page.onHide();
});
test("search empty input invalidates pending response and unload cancels debounce", async () => {
  let done;
  const { page, timers } = load("pages/search/search.js", {
    market: { search: () => new Promise((r) => (done = r)) },
    portfolio: {},
  });
  page.onLoad();
  const req = page.runSearch("茅台");
  page.onInput({ detail: { value: "" } });
  done({ assets: [a] });
  await req;
  assert.equal(page.data.results.length, 0);
  page.onInput({ detail: { value: "黄金" } });
  assert.equal(timers.size, 1);
  page.onUnload();
  assert.equal(timers.size, 0);
});
test("London asset hides unsupported close rule", async () => {
  const london = { ...a, id: "gold-xauusd", kind: "gold", market: "GLOBAL" };
  const { page } = load("pages/asset-alert/asset-alert.js", {
    market: { resolve: async () => ({ asset: london }) },
    portfolio: { list: async () => ({ ...state, items: [london] }) },
  });
  page.onLoad({ assetId: london.id });
  await page.onShow();
  assert.equal(
    page.data.types.some((t) => t.value === "close"),
    false,
  );
  page.editRule({ currentTarget: { dataset: { type: "close" } } });
  assert.equal(page.data.editing, false);
});
test("editing existing schedule saves full identity/version only after explicit save", async () => {
  const rule = {
    id: "r1",
    assetId: a.id,
    type: "scheduled",
    enabled: false,
    time: "09:00",
    weekdaysOnly: true,
    version: 4,
  };
  let saved;
  const { page } = load("pages/asset-alert/asset-alert.js", {
    market: { resolve: async () => ({ asset: a }) },
    portfolio: {
      list: async () => ({ ...state, rules: [rule] }),
      saveRule: async (r) => {
        saved = r;
        return { ...state, rules: [{ ...r, version: 5 }] };
      },
    },
  });
  page.onLoad({ assetId: a.id });
  await page.onShow();
  page.editRule({ currentTarget: { dataset: { type: "scheduled" } } });
  page.onTime({ detail: { value: "10:30" } });
  assert.equal(saved, undefined);
  await page.saveRule();
  assert.deepEqual(JSON.parse(JSON.stringify(saved)), {
    id: "r1",
    assetId: a.id,
    type: "scheduled",
    enabled: false,
    time: "10:30",
    weekdaysOnly: true,
    version: 4,
  });
  assert.equal(page.data.rules[0].version, 5);
  assert.equal(page.data.editing, false);
});
test("reminders quota rejection is shown without pretending subscription was registered", async () => {
  const { page, wx } = load("pages/reminders/reminders.js", {
    portfolio: { list: async () => state },
  });
  wx.requestSubscribeMessage = (x) => x.success({});
  wx.cloud.callFunction = async () => ({ result: { ok: false } });
  await page.onShow();
  page.onAuthTap();
  await new Promise((r) => setImmediate(r));
  assert.equal(page.data.remaining, 0);
  assert.match(page.data.errorText, /授权登记失败/);
  assert.equal(page.data.authBusy, false);
});
test("reminders retains paused rules for assets removed from watchlist", async () => {
  const rule = {
    id: "paused",
    assetId: "sz000001",
    type: "scheduled",
    enabled: false,
    time: "09:00",
    weekdaysOnly: true,
  };
  const { page } = load("pages/reminders/reminders.js", {
    market: { resolve: async () => ({ asset: { ...a, id: rule.assetId } }) },
    portfolio: { list: async () => ({ ...state, rules: [rule] }) },
  });
  await page.onShow();
  assert.equal(page.data.groups.length, 1);
  assert.equal(page.data.groups[0].id, rule.assetId);
  assert.equal(page.data.groups[0].rules[0].enabled, false);
});
test("gold detail international reference failure leaves primary quote intact", async () => {
  const gold = { ...a, id: "gold-au9999", kind: "gold", market: "SGE" };
  const { page } = load("pages/detail/detail.js", {
    market: {
      resolve: async () => ({ asset: gold }),
      quote: async () => ({ quote: { price: 100, sourceTime: 1000 } }),
      chart: async () => ({ chart: { points: [] } }),
    },
    portfolio: { list: async () => state },
    gold: {
      getIntlRef: async () => {
        throw Error("连接失败");
      },
    },
  });
  page.onLoad({ assetId: gold.id });
  await page.onShow();
  assert.equal(page.data.quote.priceText, "100.00");
  assert.equal(page.data.intlError, "");
  page.onHide();
});
test("mine uses incremental DND patch and displays per-template quota", async () => {
  const calls = [];
  const { page, wx } = load("pages/mine/mine.js", {
    portfolio: { list: async () => state },
  });
  const config = require("../utils/app-config");
  wx.cloud.callFunction = async (request) => {
    calls.push(request);
    return {
      result: {
        ok: true,
        prefs: { dndStart: "23:00", dndEnd: "07:30" },
        remaining: {
          [config.templates.dailyBrief]: 2,
          [config.templates.volatility]: 3,
        },
      },
    };
  };
  await page.onShow();
  assert.equal(page.data.quota.brief, 2);
  assert.equal(page.data.quota.vol, 3);
  await page.saveDnd({
    currentTarget: { dataset: { key: "dndStart" } },
    detail: { value: "22:00" },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1).data)), {
    prefs: { dndStart: "22:00" },
  });
  assert.equal(page.data.prefs.dndEnd, "07:30");
});
test("empty watchlist skips quote request", async () => {
  let called = false;
  const { page } = load("pages/index/index.js", {
    portfolio: { list: async () => ({ ...state, items: [] }) },
    market: {
      quotes: async () => {
        called = true;
        throw Error("空标的");
      },
    },
  });
  await page.onShow();
  assert.equal(called, false);
  assert.equal(page.data.errorText, "");
  page.onHide();
});
test("search decorates assets already followed when returning from detail", async () => {
  const { page } = load("pages/search/search.js", {
    portfolio: { list: async () => state },
    market: { search: async () => ({ assets: [a] }) },
  });
  page.onLoad();
  await page.onShow();
  await page.runSearch("茅台");
  assert.equal(page.data.results[0].added, true);
});
test("quote formatter identifies sources and Beijing time without false updated status", () => {
  const fmt = require("../utils/asset-format");
  const q = fmt.quote({ price: 10, source: "tencent", sourceTime: null });
  assert.equal(q.sourceText, "腾讯财经");
  assert.match(q.statusText, /待确认/);
  assert.doesNotMatch(q.statusText, /更新/);
  assert.match(
    fmt.time(Date.UTC(2026, 9, 26, 2, 3), Date.UTC(2026, 9, 27)),
    /10-26 10:03.*北京/,
  );
});
test("reminders exposes last five task states with safe reasons only", async () => {
  const { page, wx } = load("pages/reminders/reminders.js", {
    portfolio: { list: async () => state },
  });
  wx.cloud.callFunction = async () => ({
    result: {
      ok: true,
      recentTasks: [
        {
          taskId: "1",
          assetId: a.id,
          assetName: a.name,
          status: "no-quota",
          lastError: "private secret",
        },
        { taskId: "2", status: "pending-check", lastError: "-43101" },
        ...Array.from({ length: 5 }, (_, i) => ({
          taskId: String(i + 3),
          status: "expired",
        })),
      ],
    },
  });
  await page.onShow();
  assert.equal(page.data.recent.length, 5);
  assert.match(page.data.recent[0].reasonText, /授权次数不足/);
  assert.doesNotMatch(page.data.recent[0].reasonText, /private/);
  assert.match(page.data.recent[1].reasonText, /-43101/);
});
test("Mine syncs cloud theme after fresh installation", async () => {
  const { page, wx } = load("pages/mine/mine.js", {
    portfolio: { list: async () => state },
  });
  wx.cloud.callFunction = async () => ({
    result: { ok: true, prefs: { theme: "blackgold" } },
  });
  await page.onShow();
  assert.equal(page.data.theme, "blackgold");
});

test("drag saves once on release and cancellation restores the original order", async () => {
  const b = { ...a, id: "sz000001" };
  const c = { ...a, id: "sz000002" };
  const calls = [];
  const { page } = load("pages/index/index.js", {
    portfolio: {
      list: async () => ({ ...state, items: [a, b, c] }),
      reorder: async (ids, rev) => {
        calls.push({ ids: Array.from(ids), rev });
        return { ...state, revision: 3, items: ids.map(id => [a, b, c].find(x => x.id === id)) };
      },
    },
    market: { quotes: async () => ({ quotes: [] }) },
  });
  await page.onShow();
  const start = () => page.startDrag({ currentTarget: { dataset: { id: a.id } }, touches: [{ clientY: 40 }] });
  start(); // cannot drag outside management
  assert.equal(page.data.draggingId, "");
  page.toggleManage();
  start();
  page.dragMove({ touches: [{ clientY: 220 }] });
  assert.equal(page.data.rows[2].id, a.id);
  assert.equal(calls.length, 0);
  page.cancelDrag();
  assert.equal(page.data.rows[0].id, a.id);
  start();
  page.dragMove({ touches: [{ clientY: 220 }] });
  await page.endDrag();
  assert.deepEqual(calls, [{ ids: [b.id, c.id, a.id], rev: 2 }]);
  assert.equal(page.data.rows[2].id, a.id);
  assert.equal(page.data.busy, false);
  assert.equal(page.data.draggingId, "");
  start();
  await page.endDrag();
  assert.equal(calls.length, 1);
  page.onHide();
});

test("refresh responses cannot overwrite an active drag preview", async () => {
  const b = { ...a, id: "sz000001" };
  let finish;
  let delayed = false;
  const { page } = load("pages/index/index.js", {
    portfolio: { list: () => delayed ? new Promise(r => { finish = r; }) : Promise.resolve({ ...state, items: [a, b] }) },
    market: { quotes: async () => ({ quotes: [] }) },
  });
  await page.onShow();
  delayed = true;
  const refresh = page.reload();
  page.toggleManage();
  page.startDrag({ currentTarget: { dataset: { id: a.id } }, touches: [{ clientY: 40 }] });
  page.dragMove({ touches: [{ clientY: 120 }] });
  finish({ ...state, items: [a, b] });
  await refresh;
  assert.equal(page.data.rows[0].id, b.id);
  page.onHide();
  assert.equal(page.data.rows[0].id, a.id);
});

test("detail keeps quote and chart on failed or unusable refresh", async () => {
  let fail = false;
  const { page } = load("pages/detail/detail.js", {
    market: {
      resolve: async () => ({ asset: a }),
      quote: async () => fail ? { quote: { price: null } } : { quote: { price: 100, open: 99 } },
      chart: async () => { if (fail) throw Error("offline"); return { chart: { points: [{ time: "10:00", price: 100 }], source: "tencent" } }; },
    },
    portfolio: { list: async () => state },
  });
  page.onLoad({ assetId: a.id });
  await page.onShow();
  fail = true;
  await page.loadQuote();
  await page.loadChart();
  assert.equal(page.data.quote.priceText, "100.00");
  assert.equal(page.data.quote.open, 99);
  assert.equal(page.bars.length, 1);
  assert.match(page.data.chartError, /刷新失败/);
  assert.equal(page.data.quote.statusText, "缓存行情 · 刷新失败");
  assert.equal(page.data.quote.stale, true);
  assert.equal(page.data.errorText, "");
  page.onHide();
});
test("failed search retains previous results without a read error", async () => {
  let fail = false;
  const { page } = load("pages/search/search.js", {
    market: { search: async () => { if (fail) throw Error("offline"); return { assets: [a] }; } },
    portfolio: {},
  });
  page.onLoad();
  await page.runSearch("茅台");
  fail = true;
  await page.runSearch("茅台");
  assert.equal(page.data.results[0].id, a.id);
  assert.equal(page.data.errorText, "");
  assert.equal(page.data.loading, false);
});

test("detail follow button ignores repeat taps while a change is pending", async () => {
  let modals = 0;
  let adds = 0;
  const { page, wx } = load("pages/detail/detail.js", {
    portfolio: { add: async () => { adds++; } },
  });
  wx.showModal = () => { modals++; };
  page.data.busy = true;
  page.data.following = true;
  page.toggleFollow();
  page.data.following = false;
  await page.toggleFollow();
  assert.equal(modals, 0);
  assert.equal(adds, 0);
});

test("unfollowed detail asks before adding and opening reminder settings", async () => {
  let modal;
  const adds = [];
  const { page, wx, routes } = load("pages/detail/detail.js", {
    portfolio: { add: async id => { adds.push(id); } },
  });
  page.assetId = a.id;
  page._alive = true;
  wx.showModal = options => {
    assert.ok(Array.from(options.confirmText || "确定").length <= 4, "微信弹窗确认按钮最多 4 个字符");
    assert.ok(Array.from(options.cancelText || "取消").length <= 4, "微信弹窗取消按钮最多 4 个字符");
    modal = options;
  };
  page.openAlert();
  assert.equal(modal.content, "加入自选后才可设置提醒");
  assert.equal(modal.confirmText, "加入自选");
  assert.equal(adds.length, 0);
  assert.equal(routes.length, 0);
  await modal.success({ confirm: false });
  assert.equal(adds.length, 0);
  assert.equal(routes.length, 0);
  await modal.success({ confirm: true });
  assert.deepEqual(adds, [a.id]);
  assert.equal(page.data.following, true);
  assert.match(routes[0], /asset-alert\/asset-alert\?assetId=sh600519/);
});

test("failed follow never opens reminders, followed asset opens directly", async () => {
  let modal;
  const { page, wx, routes } = load("pages/detail/detail.js", {
    portfolio: { add: async () => { throw Error("自选已达上限"); } },
  });
  page.assetId = a.id;
  page._alive = true;
  wx.showModal = options => {
    assert.ok(Array.from(options.confirmText || "确定").length <= 4, "微信弹窗确认按钮最多 4 个字符");
    assert.ok(Array.from(options.cancelText || "取消").length <= 4, "微信弹窗取消按钮最多 4 个字符");
    modal = options;
  };
  page.openAlert();
  await modal.success({ confirm: true });
  assert.equal(routes.length, 0);
  assert.equal(page.data.following, false);
  assert.equal(page.data.errorText, "自选已达上限");
  modal = null;
  page.data.following = true;
  page.openAlert();
  assert.equal(modal, null);
  assert.equal(routes.length, 1);
});

test("reminder prerequisite stays visible if native dialog fails", () => {
  const { page, wx, routes } = load("pages/detail/detail.js");
  page._alive = true;
  wx.showModal = options => options.fail({ errMsg: "showModal:fail" });
  page.openAlert();
  assert.match(page.data.errorText, /加入自选后才可设置提醒/);
  assert.equal(routes.length, 0);
});

test("quote formatter ages persisted data and gives statistics explicit units", () => {
  const fmt = require('../utils/asset-format');
  const q = fmt.quote({price:100,source:'tencent',sourceTime:Date.now()-3600000,status:'fresh',volume:38669,amount:5226800000}, a);
  assert.equal(q.statusText, '延迟行情');
  assert.equal(q.volumeText, '3.87 万手');
  assert.equal(q.amountText, '52.27 亿元');
  assert.equal(fmt.quote({volume:3866900,source:'sina'}, a).volumeText, '3.87 万手');
  assert.equal(fmt.quote({volume:0,amount:0,source:'tencent'}, a).amountText, '0.00 元');
  assert.equal(fmt.quote({volume:100,source:'unknown'}, a).volumeText, '--');
});

test("detail refresh updates quote, chart and international reference together", async () => {
  let quotes = 0, charts = 0;
  const {page, timers} = load('pages/detail/detail.js', {
    market:{resolve:async()=>({asset:a}),quote:async()=>({quote:{price:100+quotes++}}),chart:async()=>{charts++;return {chart:{points:[{time:'10:00',price:100}]}};}},
    portfolio:{list:async()=>state},
  });
  page.onLoad({assetId:a.id}); await page.onShow();
  assert.equal(charts,1);
  await Array.from(timers.values())[0]();
  assert.equal(quotes,2); assert.equal(charts,2);
  await page.refreshMarket();
  assert.equal(quotes,3); assert.equal(charts,3);
  page.onHide();
});

test("detail reports first chart failure and recovers by switching period", async () => {
  let fail = true;
  const {page} = load('pages/detail/detail.js', {
    market:{chart:async()=>{if(fail) throw Error('offline');return {chart:{candles:[{time:'2026-10-27',c:100}],source:'tencent'}};}},
  });
  page.onLoad({assetId:a.id}); page._visible = true;
  await page.loadChart();
  assert.match(page.data.chartError,/暂不可用/);
  assert.equal(page.data.chartLoading,false);
  fail = false;
  await page.switchPeriod({currentTarget:{dataset:{period:'1mo'}}});
  assert.equal(page.data.hasChart,true);
  assert.equal(page.data.chartError,'');
  assert.equal(page.data.period,'1mo');
});

test("detail replaces incomplete new-day quote rather than carrying yesterday's statistics", async () => {
  const {page} = load('pages/detail/detail.js', {
    market:{quote:async()=>({quote:{price:102,open:null,prevClose:null,volume:null,amount:null,source:'sina',sourceTime:Date.now()}})},
  });
  page.onLoad({assetId:a.id});
  page.data.quote = {price:100,open:99,prevClose:98,volume:500,amount:50000};
  await page.loadQuote();
  for (const key of ['open','prevClose','volume','amount']) assert.equal(page.data.quote[key],null);
});

test('watchlist re-evaluates retained quote age before its next network response', async () => {
  const {page} = load('pages/index/index.js');
  page.data.rows = [{...a,price:100,sourceTime:Date.now()-3600000,status:'fresh',statusText:'行情更新'}];
  page.applyState(state);
  assert.equal(page.data.rows[0].statusText,'延迟行情');
});

test('fallback without a verified time still announces cache use', () => {
  const fmt = require('../utils/asset-format');
  const q = fmt.quote({price:100,sourceTime:null,cached:true,stale:true}, a);
  assert.match(q.statusText,/缓存/);
  assert.match(q.timeText,/待确认/);
});

test('returning to detail starts a fresh refresh while a hidden request is pending', async () => {
  let finish;
  let calls = 0;
  const {page} = load('pages/detail/detail.js', {
    market:{resolve:async()=>({asset:a}),quote:async()=>{
      if (++calls === 1) return new Promise(r=>{finish=r;});
      return {quote:{price:102,sourceTime:Date.now()}};
    },chart:async()=>({chart:{points:[]}})},
    portfolio:{list:async()=>state},
  });
  page.onLoad({assetId:a.id}); page._visible=true;
  const old = page.refreshMarket();
  page.onHide();
  await page.onShow();
  assert.equal(calls,2);
  assert.equal(page.data.quote.price,102);
  finish({quote:{price:99}}); await old;
  assert.equal(page.data.quote.price,102);
  page.onHide();
});

test('cached chart fallback exposes a retry message while retaining plotted data', async () => {
  const {page} = load('pages/detail/detail.js', {
    market:{chart:async()=>({chart:{points:[{time:'10:00',price:100}],source:'tencent',cached:true,stale:true}})},
  });
  page.onLoad({assetId:a.id}); page._visible = true;
  await page.loadChart();
  assert.equal(page.data.hasChart,true);
  assert.match(page.data.chartError,/刷新失败/);
  assert.match(page.data.chartHint,/缓存/);
});
