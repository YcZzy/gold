const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../pages/alert/alert.js'), 'utf8');
function setup() {
  let page, nextTimer = 0;
  const timers = new Map(), calls = [], toasts = [];
  const wx = { showToast: x => toasts.push(x.title), cloud: { callFunction: x => new Promise((resolve, reject) => calls.push({ ...x, resolve, reject })) } };
  vm.runInNewContext(source, { Page: x => { page = x; }, wx, require: p => p.includes('status-client') ? require('../utils/status-client') : p.includes('app-config') ? { cloudEnv: 'env', templates: { dailyBrief: 'brief', volatility: 'vol' }, quotaCapPerTemplate: 200 } : { getTheme: () => 'paper', applyChrome() {}, syncFromPrefs: p => p?.theme || 'paper' }, setTimeout: f => { timers.set(++nextTimer, f); return nextTimer; }, clearTimeout: id => timers.delete(id), Date, Math });
  page.data = JSON.parse(JSON.stringify(page.data));
  page.setData = patch => Object.entries(patch).forEach(([k,v]) => { const parts = k.split('.'); let obj = page.data; while (parts.length > 1) obj = obj[parts.shift()]; obj[parts[0]] = v; });
  const change = (key, value) => ({ currentTarget: { dataset: { key } }, detail: { value } });
  return { page, calls, timers, toasts, change };
}
const plain = x => JSON.parse(JSON.stringify(x));
test('new reminder defaults and threshold options', () => {
  const { page } = setup();
  assert.equal(page.data.prefs.scheduledTime, '09:00');
  assert.equal(page.data.prefs.scheduledWeekdaysOnly, true);
  assert.equal(page.data.prefs.volatilityPct, 1.5);
  assert.equal(page.data.prefs.shortPct, 1);
  assert.deepEqual(plain(page.data.pctOptions), [0.5,1,1.5,2,3,5]);
  for (const key of ['targetAuLow','targetAuHigh','targetXauLow','targetXauHigh']) {
    assert.equal(page.data.prefs[key], false);
    assert.equal(page.data.prefs[key+'Price'], null);
  }
});
test('save patches serialize and stale save response cannot clobber later edits', async () => {
  const { page, calls, change } = setup();
  page.onSwitch(change('volatilityAu', true));
  const save = page.doSave();
  page.onSwitch(change('volatilityAu', false));
  page.onSwitch(change('shortAu', true));
  page.doSave();
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].data.prefs), { volatilityAu: true });
  calls[0].resolve({ result: { ok: true, prefs: { volatilityAu: true, targetAuLow: false } } });
  await save;
  assert.equal(page.data.prefs.volatilityAu, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(plain(calls[1].data.prefs), { volatilityAu: false, shortAu: true });
  calls[1].resolve({ result: { ok: true } });
});
test('target price validation and switch whitelist prevent bad saves', () => {
  const { page, change, toasts } = setup();
  page.onSwitch(change('theme', true));
  page.onSwitch(change('targetAuLow', true));
  assert.equal(page.data.prefs.theme, undefined);
  assert.equal(page.data.prefs.targetAuLow, false);
  assert.ok(toasts.length);
  for (const value of ['0','-2','1000000.01','2.123','NaN']) page.onTargetPrice(change('targetAuLow', value));
  assert.equal(page.data.prefs.targetAuLowPrice, null);
  page.onTargetPrice(change('targetAuLow', '800.25'));
  page.onSwitch(change('targetAuLow', true));
  assert.equal(page.data.prefs.targetAuLowPrice, 800.25);
  assert.equal(page.data.prefs.targetAuLow, true);
});
test('failed patch retains changes for retry without showing the backend error', async () => {
  const { page, calls, change, toasts } = setup();
  page.onSwitch(change('shortXau', true));
  const saved = page.doSave();
  calls[0].resolve({ result: { ok: false, hint: '请稍后重试' } });
  await saved;
  assert.equal(toasts.length, 0);
  page.doSave();
  assert.deepEqual(plain(calls[1].data.prefs), { shortXau: true });
  calls[1].resolve({ result: { ok: true } });
});
test('onShow refresh reflects autooff while preserving edits made during request', async () => {
  const { page, calls, change } = setup();
  page.data.prefs.targetAuLow = true;
  const refresh = page.onShow();
  page.onSwitch(change('shortAu', true));
  calls[0].resolve({ result: { ok: true, prefs: { targetAuLow: false, shortAu: false } } });
  await refresh;
  assert.equal(page.data.prefs.targetAuLow, false);
  assert.equal(page.data.prefs.shortAu, true);
});
test('unload flushes pending save and picker updates only allowed fields', () => {
  const { page, calls, timers, change } = setup();
  page.onPctChange(change('volatilityPct', '4'));
  page.onScheduledTime({ detail: { value: '08:17' } });
  page.onUnload();
  assert.equal(timers.size, 0);
  assert.deepEqual(plain(calls[0].data.prefs), { volatilityPct: 3, scheduledTime: '08:17' });
  calls[0].resolve({ result: { ok: true } });
});
test('all ten task types have readable names', () => {
  const { page } = setup();
  const types = ['dailyBrief','scheduledBrief','volAu','volXau','shortAu','shortXau','targetAuLow','targetAuHigh','targetXauLow','targetXauHigh'];
  page.applyStatus({ recentTasks: types.map(type => ({ type })) });
  assert.ok(page.data.recent.every((task, i) => task.typeText !== types[i]));
});
test('refresh started before a save cannot revert the saved preference', async () => {
  const { page, calls, change } = setup();
  page.onSwitch(change('shortAu', true));
  const refresh = page.refreshStatus();
  const save = page.doSave();
  calls[1].resolve({ result: { ok: true, prefs: { shortAu: true } } });
  await save;
  calls[0].resolve({ result: { ok: true, prefs: { shortAu: false } } });
  await refresh;
  assert.equal(page.data.prefs.shortAu, true);
});
test('failed in-flight save retains newest edit rather than restoring the old value', async () => {
  const { page, calls, change } = setup();
  page.onSwitch(change('shortAu', true));
  const save = page.doSave();
  page.onSwitch(change('shortAu', false));
  calls[0].reject(new Error('offline'));
  await save;
  page.doSave();
  assert.deepEqual(plain(calls[1].data.prefs), { shortAu: false });
  calls[1].resolve({ result: { ok: true } });
});
test('clearing target price disables rule and sends null without server rule IDs', async () => {
  const { page, calls, change } = setup();
  page.data.prefs.targetAuLowRuleId = 'server-owned';
  page.onTargetPrice(change('targetAuLow', '777'));
  page.onSwitch(change('targetAuLow', true));
  page.onTargetPrice(change('targetAuLow', ''));
  const save = page.doSave();
  assert.deepEqual(plain(calls[0].data.prefs), { targetAuLowPrice: null, targetAuLow: false });
  calls[0].resolve({ result: { ok: true } });
  await save;
});
test('WXML exposes the ten controls with truthful shared quota and delay descriptions', () => {
  const markup = fs.readFileSync(require.resolve('../pages/alert/alert.wxml'), 'utf8');
  for (const label of ['简报 / 定时播报', '到价 / 波动预警', '时效内顺延，过期预警不补发', '6 类', '15 分钟', 'type="digit"']) assert.ok(markup.includes(label), label);
  assert.ok(!markup.includes('合并发送'));
});
test('recent tasks explain actionable states, safe errors, and actual sent time', () => {
  const { page } = setup();
  const reasons = ['settings-changed','stale-alert','dnd-past-expiry','dnd','daily-cap','quote-unavailable'];
  page.applyStatus({ recentTasks: [
    ...reasons.map(reason => ({ type: 'volAu', status: 'pending', reason })),
    { status: 'processing' }, { status: 'no-quota' }, { status: 'no-auth', lastError: '43101' },
    { status: 'pending-check', lastError: 'secret-token-user-123' },
    { status: 'sent', triggerTime: 100000, sentAt: 900000 }
  ] });
  const recent = page.data.recent;
  assert.ok(recent.slice(0, 6).every(t => t.reasonText && !reasons.includes(t.reasonText)));
  assert.equal(recent[6].statusText, '发送中');
  assert.match(recent[7].reasonText, /授权/);
  assert.match(recent[8].reasonText, /授权.*43101/);
  assert.match(recent[9].reasonText, /日志/);
  assert.ok(!recent[9].reasonText.includes('secret'));
  assert.equal(recent[10].timeText, page.fmtTs(900000));
});
test('invalid intermediate price explicitly says unsaved and prior valid rule remains', () => {
  const { page, change } = setup();
  page.onTargetPrice(change('targetAuLow', '800'));
  page.onSwitch(change('targetAuLow', true));
  page.onTargetPrice(change('targetAuLow', '800.'));
  assert.match(page.data.priceErrors.targetAuLow, /未保存.*上次有效/);
  assert.equal(page.data.prefs.targetAuLowPrice, 800);
});

test('picker chevrons use independent icon slots instead of font glyphs', () => {
  const markup = fs.readFileSync(require.resolve('../pages/alert/alert.wxml'), 'utf8');
  assert.ok(!markup.includes('⌄'));
  assert.equal((markup.match(/class="picker-arrow-slot"/g) || []).length, 3);
});
test('slow target price typing never saves intermediate prices until blur', () => {
  const { page, calls, timers, change } = setup();
  page.data.prefs.targetAuHigh = true;
  page.data.prefs.targetAuHighPrice = 1000;
  for (const value of ['9','90','900']) {
    page.onTargetDraft(change('targetAuHigh', value));
    for (const [id, callback] of [...timers]) { timers.delete(id); callback(); }
    assert.equal(calls.length, 0);
    assert.equal(page.data.prefs.targetAuHighPrice, 1000);
  }
  page.applyStatus({ prefs: { targetAuHighPrice: 1000 } });
  assert.equal(page.data.priceDrafts.targetAuHigh, '900');
  page.onTargetPrice(change('targetAuHigh', '900'));
  page.doSave();
  assert.deepEqual(plain(calls[0].data.prefs), { targetAuHighPrice: 900 });
  calls[0].resolve({ result: { ok: true } });
});
test('explicit target enable commits validated draft and switch in one patch', () => {
  const { page, calls, change } = setup();
  page.onTargetDraft(change('targetXauHigh', '3900.25'));
  page.onSwitch(change('targetXauHigh', true));
  page.doSave();
  assert.deepEqual(plain(calls[0].data.prefs), { targetXauHighPrice: 3900.25, targetXauHigh: true });
  calls[0].resolve({ result: { ok: true } });
});
