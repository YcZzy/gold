const test = require('node:test');
const assert = require('node:assert/strict');
const { createKlineChart } = require('../utils/candle-chart');

function fixture() {
  const calls = [];
  const ctx = new Proxy({}, { get(target, key) {
    return target[key] || ((...args) => calls.push({ name: key, args, style: target.strokeStyle }));
  }, set(target, key, value) { target[key] = value; return true; } });
  const chart = createKlineChart({ ctx, width: 350, height: 300, precision: 3 });
  const bars = Array.from({ length: 40 }, (_, i) => ({ time: '2026-10-' + String(i + 1).padStart(2, '0'),
    o: 3 + i / 40, c: 3.1 + i / 40, h: 3.2 + i / 40, l: 2.9 + i / 40, v: 100 + i }));
  return { chart, calls, bars };
}

test('custom moving averages can be changed and disabled without removing candles', () => {
  const { chart, calls, bars } = fixture();
  chart.setIndicators({ maPeriods: [3, 12, 25], maEnabled: true, subIndicator: 'volume' });
  chart.render(bars);
  const enabledStrokes = calls.filter(c => c.name === 'stroke').length;
  calls.length = 0;
  chart.setIndicators({ maPeriods: [3, 12, 25], maEnabled: false, subIndicator: 'volume' });
  chart.render(bars);
  assert.equal(enabledStrokes - calls.filter(c => c.name === 'stroke').length, 3);
  assert.ok(calls.some(c => c.name === 'fillRect'));
});

test('only target lines inside the natural range are drawn and touch preserves them', () => {
  const { chart, calls, bars } = fixture();
  chart.setTargets([{ type: 'priceAbove', value: 3.8 }, { type: 'priceBelow', value: 0.01 }]);
  chart.render(bars);
  assert.ok(calls.some(c => c.name === 'fillText' && c.args[0] === '涨到 3.800'));
  assert.ok(!calls.some(c => c.name === 'fillText' && String(c.args[0]).includes('0.010')));
  const labels = calls.filter(c => c.name === 'fillText').map(c => c.args[0]);
  assert.ok(!labels.includes('0.0'), 'outlying target must not stretch the price axis');
  calls.length = 0;
  assert.ok(chart.touchAt(150));
  assert.ok(calls.some(c => c.name === 'fillText' && c.args[0] === '涨到 3.800'));
  calls.length = 0;
  chart.setTargets([]);
  chart.render(bars);
  assert.ok(!calls.some(c => c.name === 'fillText' && String(c.args[0]).includes('涨到')));
});

test('MACD occupies the candle subplot while intraday retains volume and target lines', () => {
  const { chart, calls, bars } = fixture();
  chart.setIndicators({ maPeriods: [5], maEnabled: true, subIndicator: 'macd' });
  chart.setTargets([{ type: 'priceBelow', value: 3.5 }]);
  chart.render(bars);
  assert.ok(calls.some(c => c.name === 'fillText' && c.args[0] === 'MACD(12,26,9)'));
  for (const c of calls.filter(c => ['moveTo', 'lineTo', 'fillRect'].includes(c.name)))
    assert.ok(c.args.every(Number.isFinite), JSON.stringify(c));
  calls.length = 0;
  chart.renderIntraday(bars.map(b => ({ time: b.time, price: b.c, avg: b.c, v: b.v })), 3);
  assert.ok(!calls.some(c => c.name === 'fillText' && c.args[0] === 'MACD(12,26,9)'));
  assert.ok(calls.some(c => c.name === 'fillText' && c.args[0] === '跌到 3.500'));
});
