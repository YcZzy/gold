const test = require('node:test');
const assert = require('node:assert/strict');
const features = require('../utils/chart-features');

const candles = values => values.map(c => ({ c }));
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

test('moving averages wait for a full window and slide over closing prices', () => {
  assert.deepEqual(features.movingAverage(candles([1, 2, 3, 7]), 3), [null, null, 2, 4]);
  assert.deepEqual(features.movingAverage([], 5), []);
});

test('MACD uses EMA(12,26), DEA(9) and twice the divergence as histogram', () => {
  const rows = features.macd(candles([1, 2]));
  assert.deepEqual(rows[0], { dif: 0, dea: 0, histogram: 0 });
  const dif = 2 / 13 - 2 / 27;
  near(rows[1].dif, dif);
  near(rows[1].dea, dif / 5);
  near(rows[1].histogram, 2 * (dif - dif / 5));
  assert.deepEqual(features.macd([]), []);
  for (const row of features.macd(candles(Array(40).fill(25))))
    assert.deepEqual(row, { dif: 0, dea: 0, histogram: 0 });
  assert.ok(features.macd(candles(Array.from({ length: 40 }, (_, i) => i + 1))).at(-1).dif > 0);
});

test('indicator settings validate bounded distinct integer periods and preserve visibility', () => {
  assert.deepEqual(features.parseSettings({ maText: '5， 99,250', maEnabled: false, subIndicator: 'macd' }),
    { maPeriods: [5, 99, 250], maEnabled: false, subIndicator: 'macd' });
  assert.deepEqual(features.parseSettings({ maPeriods: [1, 128], maEnabled: true, subIndicator: 'volume' }),
    { maPeriods: [1, 128], maEnabled: true, subIndicator: 'volume' });
  for (const maText of ['', '0,5', '5,251', '5,5', '5.5', '5,10,20,30', '5x', '-1', '1e2'])
    assert.throws(() => features.parseSettings({ maText, maEnabled: true, subIndicator: 'volume' }), /均线/);
  assert.throws(() => features.parseSettings({ maText: '5', maEnabled: true, subIndicator: 'unknown' }), /副图/);
});

test('price target summaries filter asset and active price rules, preserve precision and signed distance', () => {
  const asset = { id: 'sh510300', precision: 3 };
  const rules = [
    { id: 'up', assetId: asset.id, type: 'priceAbove', value: 4.2, enabled: true },
    { id: 'down', assetId: asset.id, type: 'priceBelow', value: 3.9, enabled: true },
    { id: 'paused', assetId: asset.id, type: 'priceBelow', value: 3.8, enabled: false },
    { id: 'other', assetId: 'usSPY', type: 'priceAbove', value: 4.3, enabled: true },
    { id: 'pct', assetId: asset.id, type: 'dailyMove', value: 2, enabled: true },
    { id: 'bad', assetId: asset.id, type: 'priceAbove', value: NaN, enabled: true },
  ];
  const rows = features.targets(rules, asset, 4, { min: 3.95, max: 4.3 });
  assert.deepEqual(rows.map(r => r.id), ['up', 'down']);
  assert.equal(rows[0].priceText, '4.200');
  assert.equal(rows[0].differenceText, '+0.200');
  assert.equal(rows[0].distanceText, '+5.00%');
  assert.equal(rows[0].inRange, true);
  assert.equal(rows[1].distanceText, '-2.50%');
  assert.equal(rows[1].inRange, false);
  for (const price of [null, NaN, 0]) assert.equal(features.targets(rules, asset, price)[0].distanceText, '--');
});

test('chart range uses candle extremes or intraday prices plus previous close', () => {
  assert.deepEqual(features.chartRange([{ l: 3, h: 5 }, { l: 2, h: 4 }], 'candle'), { min: 2, max: 5 });
  assert.deepEqual(features.chartRange([{ price: 3 }, { price: 4 }], 'intraday', 5), { min: 3, max: 5 });
  assert.equal(features.chartRange([], 'candle'), null);
});
