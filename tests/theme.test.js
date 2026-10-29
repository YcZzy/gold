const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function load(stored = "paper") {
  const items = [];
  const styles = [];
  const synced = [];
  const wx = {
    getStorageSync: () => stored,
    setStorageSync: (_, value) => { stored = value; },
    setNavigationBarColor() {},
    setTabBarStyle: value => styles.push(value),
    setTabBarItem: value => items.push(value),
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../utils/theme.js"), "utf8"), {
    wx, module, getCurrentPages: () => [{ getTabBar: () => ({ syncFromPage: value => synced.push(value) }) }],
  });
  return { theme: module.exports, items, styles, synced, wx };
}

function checkItems(items, themeName) {
  assert.equal(items.length, 3);
  for (const [index, name] of ["watchlist", "reminders", "mine"].entries()) {
    assert.equal(items[index].index, index);
    for (const [key, state] of [["iconPath", "normal"], ["selectedIconPath", "selected"]]) {
      const file = `assets/icons/tabbar/${name}-${themeName}-${state}.png`;
      assert.equal(items[index][key], file);
      const png = fs.readFileSync(path.join(__dirname, "..", file));
      assert.equal(png.subarray(1, 4).toString(), "PNG");
      assert.equal(png.readUInt32BE(16), 72);
      assert.equal(png.readUInt32BE(20), 72);
      assert.equal(png[25], 6, "RGBA transparent PNG");
    }
  }
}

test("switching paper → blackgold → paper synchronizes custom navigation and retains theme", () => {
  const { theme, items, styles, synced } = load();
  for (const name of ["paper", "blackgold", "paper"]) {
    theme.setTheme(name);
    assert.equal(theme.getTheme(), name);
    assert.equal(synced.at(-1), name);
  }
  assert.equal(items.length, 0);
  assert.equal(styles.length, 0);
});

test("cached theme restoration synchronizes custom navigation and takes priority over cloud preferences", () => {
  const { theme, synced } = load("blackgold");
  theme.applyChrome(theme.getTheme());
  assert.deepEqual(synced, ["blackgold"]);
  assert.equal(theme.syncFromPrefs({ theme: "paper" }), "blackgold");
  assert.equal(synced.length, 1);
});

test("cloud preferences initialize custom navigation when no local theme exists", () => {
  const { theme, synced } = load("");
  assert.equal(theme.syncFromPrefs({ theme: "blackgold" }), "blackgold");
  assert.deepEqual(synced, ["blackgold"]);
});

test("default tab configuration provides paper icons before page initialization", () => {
  const app = require("../app.json");
  checkItems(app.tabBar.list.map((item, index) => ({ ...item, index })), "paper");
});

test("custom navigation does not depend on native tab-bar APIs", () => {
  const { theme, wx, styles, synced } = load();
  delete wx.setTabBarItem;
  assert.doesNotThrow(() => theme.applyChrome("blackgold"));
  assert.equal(styles.length, 0);
  assert.deepEqual(synced, ["blackgold"]);
});
