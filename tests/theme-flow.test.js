const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function setup(initial) {
  const storage = new Map(initial ? [["gold-theme", initial]] : []);
  const calls = [];
  const chrome = [];
  const navigation = [];
  let activePage;
  const wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    setNavigationBarColor: value => navigation.push(value),
    setBackgroundColor() {}, setTabBarStyle() {}, setTabBarItem() {},
    cloud: { callFunction: request => new Promise((resolve, reject) => calls.push({ ...request, resolve, reject })) },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../utils/theme.js"), "utf8"), {
    wx, module, getCurrentPages: () => activePage ? [activePage] : [],
  });
  const theme = module.exports;
  function page(name) {
    let result;
    const filename = path.join(__dirname, `../pages/${name}/${name}.js`);
    vm.runInNewContext(fs.readFileSync(filename, "utf8"), {
      wx, Page: value => { result = value; }, console,
      setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
      require: id => {
        if (id.includes("theme")) return theme;
        if (id.includes("portfolio-client")) return { list: async () => ({ items: [], rules: [], limits: {} }) };
        if (id.includes("market-client")) return { resolve: async () => ({ asset: { id: "sh600519", market: "SH" } }) };
        return require(path.resolve(path.dirname(filename), id));
      },
    });
    result.data = JSON.parse(JSON.stringify(result.data));
    result.setData = patch => Object.assign(result.data, patch);
    result.getTabBar = () => ({ syncFromPage: value => chrome.push(value === "blackgold" ? "#14120b" : "#FAF8F3") });
    activePage = result;
    return result;
  }
  return { wx, theme, calls, chrome, navigation, storage, page };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test("a late cloud response cannot undo a local dark-theme choice after navigating away", async () => {
  const f = setup("paper");
  const mine = f.page("mine");
  const loading = mine.onShow();
  mine.onThemeTap();
  if (mine.onHide) mine.onHide();
  const home = f.page("index");
  await home.onShow();
  assert.equal(home.data.theme, "blackgold");
  f.calls.find(c => c.name === "getStatus").resolve({ result: { ok: true, prefs: { theme: "paper" } } });
  await loading;
  assert.equal(f.theme.getTheme(), "blackgold", "hidden Mine must not reset the global choice");
  assert.equal(f.chrome.at(-1), "#14120b", "native chrome must match the visible page");
  const reminders = f.page("reminders");
  const showing = reminders.onShow();
  await tick();
  f.calls.filter(c => c.name === "getStatus").at(-1).resolve({ result: { ok: true, prefs: { theme: "paper" } } });
  await showing;
  assert.equal(reminders.data.theme, "blackgold");
});

test("offline status fallback cannot override a locally selected theme", async () => {
  const f = setup();
  const mine = f.page("mine");
  let showing = mine.onShow();
  f.calls[0].resolve({ result: { ok: true, prefs: { theme: "paper" } } });
  await showing;
  mine.onThemeTap();
  showing = mine.onShow();
  f.calls.filter(c => c.name === "getStatus").at(-1).reject(Error("offline"));
  await showing;
  assert.equal(mine.data.theme, "blackgold");
  assert.equal(f.theme.getTheme(), "blackgold");
});

test("a hidden Mine page cannot initialize the theme from cloud preferences", async () => {
  const f = setup();
  const mine = f.page("mine");
  const showing = mine.onShow();
  if (mine.onHide) mine.onHide();
  const home = f.page("index");
  await home.onShow();
  f.calls[0].resolve({ result: { ok: true, prefs: { theme: "blackgold" } } });
  await showing;
  assert.equal(f.theme.getTheme(), home.data.theme);
  assert.equal(f.chrome.at(-1), "#FAF8F3");
});

test("a first installation can restore cloud theme while Mine remains visible", async () => {
  const f = setup();
  const mine = f.page("mine");
  const showing = mine.onShow();
  f.calls[0].resolve({ result: { ok: true, prefs: { theme: "blackgold" } } });
  await showing;
  assert.equal(mine.data.theme, "blackgold");
  assert.equal(f.theme.getTheme(), "blackgold");
});

test("all pages initialize and resume using the current local theme", async () => {
  const f = setup("blackgold");
  for (const name of ["index", "reminders", "mine", "search", "detail", "asset-alert", "alert"]) {
    const page = f.page(name);
    assert.equal(page.data.theme, "blackgold", `${name}: first render`);
    page.reload = async () => {};
    page.refreshStatus = async () => {};
    page.restorePortfolio = () => {};
    page.assetId = "sh600519";
    await page.onShow();
    assert.equal(page.data.theme, "blackgold", `${name}: resume`);
    assert.equal(f.navigation.at(-1).backgroundColor, "#14120b", `${name}: native navigation resumes dark`);
    f.theme.setTheme("paper");
    await page.onShow();
    assert.equal(page.data.theme, "paper", `${name}: return after switching to paper`);
    f.theme.setTheme("blackgold");
    await page.onShow();
    assert.equal(page.data.theme, "blackgold", `${name}: return after switching to dark`);
  }
});

test("theme survives unavailable local storage during this session", () => {
  const f = setup();
  f.wx.getStorageSync = () => { throw Error("storage unavailable"); };
  f.wx.setStorageSync = () => { throw Error("storage unavailable"); };
  f.theme.setTheme("blackgold");
  assert.equal(f.theme.getTheme(), "blackgold");
});

test("tab pages read the current theme on load even when registered before a theme change", () => {
  const f = setup("paper");
  const pages = ["index", "reminders", "mine"].map(name => f.page(name));
  f.theme.setTheme("blackgold");
  for (const page of pages) {
    if (page.onLoad) page.onLoad();
    assert.equal(page.data.theme, "blackgold", "first render must not use the registration-time theme");
  }
});

test("native page containers have a non-white fallback before WXML is rendered", () => {
  const app = require("../app.json");
  assert.equal(app.window.backgroundColorContent, "#F4F1EA");
  for (const route of app.pages) {
    const config = require(path.join("..", route + ".json"));
    assert.equal(config.backgroundColorContent || app.window.backgroundColorContent, "#F4F1EA", route);
  }
});

test("every page applies the current theme during load before show or network responses", () => {
  const f = setup("paper");
  const names = ["index", "reminders", "mine", "search", "detail", "asset-alert", "alert"];
  const pages = names.map(name => f.page(name));
  f.theme.setTheme("blackgold");
  pages.forEach((page, index) => {
    page.restorePortfolio = () => {};
    const before = f.navigation.length;
    page.onLoad({ assetId: "sh600519" });
    assert.equal(page.data.theme, "blackgold", `${names[index]}: load uses latest theme`);
    assert.equal(f.navigation.length, before + 1, `${names[index]}: native theme applied before show`);
    assert.equal(f.navigation.at(-1).backgroundColor, "#14120b");
  });
});

test("every page binds its underlying background to the same theme as its content", () => {
  for (const name of ["index", "reminders", "mine", "search", "detail", "asset-alert", "alert"]) {
    const markup = fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.wxml`), "utf8");
    assert.match(markup, /^<page-meta\b[^>]*page-style="[^"]*background-color:[^"]*theme[^\"]*"/, name);
    assert.match(markup, /^<page-meta\b[^>]*background-color="[^"]*theme/, name);
  }
});

test("theme changes explicitly update native navigation without repainting native tabs or window", () => {
  const f = setup("paper");
  const calls = [];
  for (const name of ["setBackgroundColor", "setTabBarStyle", "setTabBarItem"])
    f.wx[name] = () => calls.push(name);
  f.theme.applyChrome("paper");
  f.theme.setTheme("blackgold");
  f.theme.setTheme("paper");
  assert.deepEqual(f.navigation.map(v => [v.frontColor, v.backgroundColor]), [
    ["#000000", "#FAF8F3"], ["#ffffff", "#14120b"], ["#000000", "#FAF8F3"],
  ]);
  assert.ok(f.navigation.every(v => v.animation.duration === 0));
  assert.deepEqual(calls, []);
});

test("pages keep declarative window backgrounds without a competing navigation color declaration", () => {
  for (const name of ["index", "reminders", "mine", "search", "detail", "asset-alert", "alert"]) {
    const markup = fs.readFileSync(path.join(__dirname, `../pages/${name}/${name}.wxml`), "utf8");
    assert.match(markup, /^<page-meta\b[^>]*root-background-color="[^"]*theme/, name);
    assert.doesNotMatch(markup, /<navigation-bar\b/, name);
  }
});

test("rapid theme changes save in order, with the last choice sent last", async () => {
  const f = setup("paper");
  f.theme.setTheme("blackgold");
  f.theme.setTheme("paper");
  assert.equal(f.calls.length, 1, "only one theme save may be in flight");
  f.calls[0].resolve({ result: { ok: true } });
  await tick();
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[1].data.prefs.theme, "paper");
});

test("a rejected save does not undo the local choice or block a newer queued save", async () => {
  const f = setup("paper");
  f.theme.setTheme("blackgold");
  f.theme.setTheme("paper");
  f.theme.setTheme("blackgold");
  f.calls[0].reject(Error("offline"));
  await tick();
  assert.equal(f.theme.getTheme(), "blackgold");
  assert.equal(f.calls.length, 2, "intermediate choices are coalesced");
  assert.equal(f.calls[1].data.prefs.theme, "blackgold");
  f.calls[1].resolve({ result: { ok: false } });
  await tick();
  assert.equal(f.theme.syncFromPrefs({ theme: "paper" }), "blackgold");
});

test("an older Mine refresh cannot overwrite a newer refresh after returning", async () => {
  const f = setup();
  const mine = f.page("mine");
  const first = mine.onShow();
  if (mine.onHide) mine.onHide();
  const second = mine.onShow();
  f.calls[1].resolve({ result: { ok: true, prefs: { theme: "blackgold", dndStart: "22:00" } } });
  await second;
  f.calls[0].resolve({ result: { ok: true, prefs: { theme: "paper", dndStart: "23:00" } } });
  await first;
  assert.equal(mine.data.theme, "blackgold");
  assert.equal(mine.data.prefs.dndStart, "22:00");
});

test("a hidden legacy reminder page cannot initialize the global theme", async () => {
  const f = setup();
  const alert = f.page("alert");
  const showing = alert.onShow();
  if (alert.onHide) alert.onHide();
  const home = f.page("index");
  await home.onShow();
  f.calls[0].resolve({ result: { ok: true, prefs: { theme: "blackgold" } } });
  await showing;
  assert.equal(f.theme.getTheme(), home.data.theme);
  assert.equal(f.chrome.at(-1), "#FAF8F3");
});
