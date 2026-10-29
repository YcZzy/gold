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
    { ...features.DEFAULT_SETTINGS, maPeriods: [5, 99, 250], maEnabled: false, subIndicator: 'macd' });
  assert.deepEqual(features.parseSettings({ maPeriods: [1, 128], maEnabled: true, subIndicator: 'volume' }),
    { ...features.DEFAULT_SETTINGS, maPeriods: [1, 128], maEnabled: true, subIndicator: 'volume' });
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

test('weekly and monthly bars aggregate civil dates across years and never fabricate missing volume', () => {
  const bars = [
    {time:'2020-12-31',o:10,h:14,l:9,c:12,v:3},
    {time:'2021-01-01',o:12,h:16,l:11,c:15,v:4},
    {time:'2021-01-04',o:15,h:17,l:13,c:14,v:null},
  ];
  const weekly = features.aggregateCandles(bars, 'week', '2021-01-06');
  assert.equal(weekly.length, 2); assert.equal(weekly[0].time, '2020-12-28');
  assert.deepEqual([weekly[0].o,weekly[0].h,weekly[0].l,weekly[0].c,weekly[0].v],[10,16,9,15,7]);
  assert.equal(weekly[1].v,null); assert.equal(weekly[1].partial,true);
  assert.equal(weekly[0].startTime,'2020-12-31'); assert.equal(weekly[0].endTime,'2021-01-01');
  assert.equal(features.aggregateCandles(bars,'month','2021-01-06')[1].v,null);
});
test('BOLL uses population deviation and volume averages require a fully valid window', () => {
  const rows = features.bollinger(candles([1,2,3]),3,2);
  assert.equal(rows[1],null); near(rows[2].middle,2); near(rows[2].upper,2+2*Math.sqrt(2/3));
  assert.deepEqual(features.volumeAverage([{v:1},{v:null},{v:3},{v:5}],2),[null,null,null,4]);
});
test('viewport indicators preserve full history seed and clamp navigation', () => {
  const bars = Array.from({length:80},(_,i)=>({c:i+1,v:i}));
  const settings = features.parseSettings({...features.DEFAULT_SETTINGS,bollEnabled:true,volumeMaEnabled:true});
  const view = features.chartView(bars,settings,{count:20,offset:10});
  assert.deepEqual(view.bars,bars.slice(50,70));
  assert.deepEqual(view.indicators.macd,features.macd(bars).slice(50,70));
  assert.equal(view.indicators.ma[5][0],49); // mean close 47..51 = 49
  assert.equal(features.chartView(bars,settings,{count:20,offset:999}).start,0);
});
test('new settings default compatibly and reject invalid granularity or switches',()=>{
 const old=features.parseSettings({maPeriods:[5],maEnabled:true,subIndicator:'volume'});
 assert.equal(old.granularity,'day'); assert.equal(old.bollEnabled,false); assert.equal(old.volumeMaEnabled,false);
 assert.throws(()=>features.parseSettings({...old,granularity:'year'}),/粒度/);
 assert.throws(()=>features.parseSettings({...old,bollEnabled:'yes'}),/布林/);
});
test('historical range clipping marks the first aggregate as incomplete independently of the current period',()=>{
 const rows=features.aggregateCandles([
  {time:'2026-09-29',o:1,h:2,l:1,c:2,v:1},
  {time:'2026-09-30',o:2,h:3,l:2,c:3,v:1},
  {time:'2026-10-01',o:3,h:4,l:3,c:4,v:1},
 ],'month','2026-10-29');
 assert.equal(rows[0].startIncomplete,true);
 assert.equal(rows[0].partial,true);
 assert.equal(rows[0].startTime,'2026-09-29');
 assert.equal(rows[0].endIncomplete,false);
 assert.equal(rows[1].endIncomplete,true);
});
