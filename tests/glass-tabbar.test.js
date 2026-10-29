const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(stored = 'paper', route = 'pages/index/index') {
  const filename = path.join(__dirname, '../custom-tab-bar/index.js');
  assert.ok(fs.existsSync(filename), 'custom tab bar component must exist');
  let definition;
  let active;
  const requests = [], ticks = [], toasts = [];
  const pages = [{ route, getTabBar: () => active }];
  const wx = {
    getStorageSync: () => stored,
    setStorageSync: (_, value) => { stored = value; },
    setNavigationBarColor() {}, setBackgroundColor() {},
    setTabBarStyle() { throw Error('must not style a native tab bar when custom bar is ready'); },
    setTabBarItem() { throw Error('must not update native icons when custom bar is ready'); },
    switchTab: request => requests.push(request),
    nextTick: callback => ticks.push(callback),
    showToast: value => toasts.push(value),
  };
  const module = { exports: {} };
  const getCurrentPages = () => pages;
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/theme.js'), 'utf8'), {
    module, wx, getCurrentPages,
  });
  const theme = module.exports;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    wx, getCurrentPages, Component: value => { definition = value; },
    require: id => { assert.equal(id, '../utils/theme'); return theme; },
  });
  function create() {
    const bar = { ...definition.methods, data: JSON.parse(JSON.stringify(definition.data)) };
    bar.setData = (patch, callback) => { Object.assign(bar.data, patch); if (callback) callback(); };
    active = bar;
    definition.lifetimes.attached.call(bar);
    return bar;
  }
  return { create, pages, theme, requests, toasts, definition, wx,
    flush() { while (ticks.length) ticks.shift()(); } };
}

function tap(bar, index) { bar.switchTab({ currentTarget: { dataset: { index } } }); }

test('cold launch restores dark material and actual reminder route without an entry slide', () => {
  const f = setup('blackgold', 'pages/reminders/reminders');
  const bar = f.create(); f.flush();
  assert.equal(bar.data.theme, 'blackgold');
  assert.equal(bar.data.selected, 1);
  assert.equal(bar.data.indicatorIndex, 1);
  tap(bar, 1);
  assert.equal(f.requests.length, 0, 'current tab is not reloaded');
});

test('destination indicator moves from last confirmed route, and repeated sync cannot cancel it', () => {
  const f = setup();
  const home = f.create();
  tap(home, 2);
  assert.equal(home.data.selected, 0, 'a request is not a confirmed route');
  assert.equal(f.requests[0].url, '/pages/mine/mine');
  f.pages[0].route = 'pages/mine/mine';
  const mine = f.create();
  assert.equal(mine.data.selected, 2);
  assert.equal(mine.data.indicatorIndex, 0);
  mine.syncFromPage();
  f.flush();
  assert.equal(mine.data.indicatorIndex, 2);
});

test('failed switch retains actual selection and can be retried', () => {
  const f = setup(); const bar = f.create();
  tap(bar, 1);
  f.requests[0].fail(); f.requests[0].complete();
  f.flush();
  assert.equal(bar.data.selected, 0);
  assert.equal(bar.data.indicatorIndex, 0);
  assert.equal(f.toasts.length, 1);
  tap(bar, 1);
  assert.equal(f.requests.length, 2);
});

test('rapid taps create only one in-flight switch and success follows actual route', () => {
  const f = setup(); const bar = f.create();
  tap(bar, 1); tap(bar, 2); tap(bar, 1);
  assert.equal(f.requests.length, 1);
  f.pages[0].route = 'pages/reminders/reminders';
  if (f.requests[0].success) f.requests[0].success();
  const reminders = f.create();
  f.requests[0].complete(); f.flush();
  assert.equal(reminders.data.selected, 1);
  tap(reminders, 2);
  assert.equal(f.requests.length, 2);
});

test('returning cached tab synchronizes route and current local theme', () => {
  const f = setup(); const home = f.create();
  f.pages[0].route = 'pages/mine/mine';
  const mine = f.create();
  f.theme.setTheme('blackgold');
  assert.equal(mine.data.theme, 'blackgold');
  f.pages[0].route = 'pages/index/index';
  f.definition.pageLifetimes.show.call(home);
  assert.equal(home.data.indicatorIndex, 2, 'cached page starts from the tab being left');
  f.flush();
  assert.equal(home.data.selected, 0);
  assert.equal(home.data.theme, 'blackgold');
  assert.equal(home.data.indicatorIndex, 0);
});

test('source success callback cannot consume the destination transition', () => {
  const f = setup(); const home = f.create();
  tap(home, 1);
  f.pages[0].route = 'pages/reminders/reminders';
  if (f.requests[0].success) f.requests[0].success();
  const reminders = f.create();
  assert.equal(home.data.selected, 0, 'hidden source keeps its own confirmed route');
  assert.equal(reminders.data.indicatorIndex, 0, 'destination starts at the previous tab');
  f.flush();
  assert.equal(reminders.data.indicatorIndex, 1);
});

test('a late source completion cannot change the destination transition', () => {
  const f = setup(); const home = f.create();
  tap(home, 2);
  f.pages[0].route = 'pages/mine/mine';
  const mine = f.create();
  if (f.requests[0].success) f.requests[0].success();
  f.requests[0].complete();
  mine.syncFromPage();
  assert.equal(mine.data.indicatorIndex, 0);
  f.flush();
  assert.equal(home.data.selected, 0);
  assert.equal(mine.data.indicatorIndex, 2);
});

test('detaching cancels a queued indicator update', () => {
  const f = setup(); const bar = f.create();
  f.pages[0].route = 'pages/reminders/reminders'; bar.syncFromPage();
  f.definition.lifetimes.detached.call(bar);
  f.flush();
  assert.equal(bar.data.indicatorIndex, 0);
  assert.equal(bar.data.indicatorMotion, false);
});

test('glass navigation uses the configured routes and all icon variants exist', () => {
  const f = setup(); const bar = f.create();
  const config = require('../app.json');
  assert.equal(config.tabBar.custom, true);
  assert.deepEqual(Array.from(bar.data.tabs, t => t.pagePath), config.tabBar.list.map(t => t.pagePath));
  for (const tab of bar.data.tabs)
    for (const theme of ['paper', 'blackgold'])
      for (const state of ['normal', 'selected'])
        assert.ok(fs.existsSync(path.join(__dirname, `../assets/icons/tabbar/${tab.icon}-${theme}-${state}.png`)));
});

test('late animation callback cannot overwrite a newer route', () => {
  const f = setup(); const bar = f.create();
  f.pages[0].route = 'pages/reminders/reminders'; bar.syncFromPage();
  f.pages[0].route = 'pages/index/index'; bar.syncFromPage();
  f.flush();
  assert.equal(bar.data.indicatorIndex, 0);
});

test('invalid indices do not navigate', () => {
  const f = setup(); const bar = f.create();
  for (const index of [-1, 3, '', null, 'wrong', 1.5]) tap(bar, index);
  assert.equal(f.requests.length, 0);
});

for (const [from, to] of [[0, 1], [1, 0], [1, 2], [2, 1], [0, 2], [2, 0]]) {
  for (const cached of [false, true]) {
    test(`slide ${from + 1} -> ${to + 1}, ${cached ? 'cached' : 'first visit'}`, () => {
      const routes = ['pages/index/index', 'pages/reminders/reminders', 'pages/mine/mine'];
      const f = setup('paper', routes[cached ? to : from]);
      let target;
      if (cached) {
        target = f.create(); f.flush();
        f.pages[0].route = routes[from];
      }
      f.create(); f.flush();
      f.pages[0].route = routes[to];
      if (cached) f.definition.pageLifetimes.show.call(target);
      else target = f.create();
      assert.equal(target.data.indicatorFrom, from);
      assert.equal(target.data.indicatorIndex, from);
      target.syncFromPage();
      f.flush();
      assert.equal(target.data.selected, to);
      assert.equal(target.data.indicatorFrom, from);
      assert.equal(target.data.indicatorIndex, to);
      assert.equal(target.data.indicatorMotion, true);
      assert.equal(target.data.indicatorDuration, Math.abs(to - from) === 2 ? 320 : 250);
    });
  }
}

test('hiding a page cancels its queued motion without consuming the next slide', () => {
  const f = setup(); const home = f.create();
  f.pages[0].route = 'pages/reminders/reminders';
  const reminders = f.create();
  f.definition.pageLifetimes.hide.call(reminders);
  f.pages[0].route = 'pages/index/index';
  f.definition.pageLifetimes.show.call(home);
  f.flush();
  assert.equal(reminders.data.indicatorMotion, false);
  assert.equal(home.data.indicatorFrom, 1);
  assert.equal(home.data.indicatorIndex, 0);
});
