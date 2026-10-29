const fmt = require('./asset-format');
const DEFAULT_SETTINGS = { maPeriods: [5, 10], maEnabled: true, subIndicator: 'volume', granularity: 'day', bollEnabled: false, volumeMaEnabled: false };
const STORAGE_KEY = 'chart-indicators-v1';

function movingAverage(candles, period) {
  let sum = 0;
  return candles.map((bar, i) => {
    sum += bar.c;
    if (i >= period) sum -= candles[i - period].c;
    return i >= period - 1 ? sum / period : null;
  });
}

// Both EMAs start at the first available close; histogram follows the 2*(DIF-DEA) convention.
function macd(candles) {
  if (!candles.length) return [];
  let fast = candles[0].c, slow = fast, dea = 0;
  return candles.map(bar => {
    fast += (bar.c - fast) * 2 / 13;
    slow += (bar.c - slow) * 2 / 27;
    const dif = fast - slow;
    dea += (dif - dea) * 2 / 10;
    return { dif, dea, histogram: 2 * (dif - dea) };
  });
}

function parseSettings(input) {
  if (!input || typeof input.maEnabled !== 'boolean') throw Error('请选择是否显示均线');
  const tokens = typeof input.maText === 'string'
    ? input.maText.trim().split(/[,，\s]+/)
    : Array.isArray(input.maPeriods) ? input.maPeriods.map(String) : [];
  if (!tokens.length || tokens.length > 3 || tokens.some(t => !/^\d{1,3}$/.test(t)))
    throw Error('均线请输入 1–3 个整数，用逗号分隔');
  const maPeriods = tokens.map(Number);
  if (maPeriods.some(n => n < 1 || n > 250) || new Set(maPeriods).size !== maPeriods.length)
    throw Error('均线周期需为 1–250 且不能重复');
  if (!['volume', 'macd'].includes(input.subIndicator)) throw Error('请选择成交量或 MACD 副图');
  const granularity = input.granularity || 'day';
  if (!['day', 'week', 'month'].includes(granularity)) throw Error('请选择日、周或月 K 线粒度');
  for (const [key, label] of [['bollEnabled', '布林带'], ['volumeMaEnabled', '量均线']])
    if (input[key] != null && typeof input[key] !== 'boolean') throw Error(label + '开关无效');
  return { maPeriods, maEnabled: input.maEnabled, subIndicator: input.subIndicator,
    granularity, bollEnabled: input.bollEnabled === true, volumeMaEnabled: input.volumeMaEnabled === true };
}

function chartRange(bars, mode, prevClose) {
  const values = bars.flatMap(bar => mode === 'intraday' ? [bar.price] : [bar.l, bar.h]);
  if (mode === 'intraday' && Number.isFinite(prevClose) && prevClose > 0) values.push(prevClose);
  const valid = values.filter(v => typeof v === 'number' && Number.isFinite(v) && v > 0);
  return valid.length ? { min: Math.min(...valid), max: Math.max(...valid) } : null;
}

function targets(rules, asset, price, range) {
  const validPrice = typeof price === 'number' && Number.isFinite(price) && price > 0;
  const precision = asset.precision == null ? 2 : asset.precision;
  return rules.filter(rule => rule.assetId === asset.id && rule.enabled === true &&
    ['priceAbove', 'priceBelow'].includes(rule.type) &&
    typeof rule.value === 'number' && Number.isFinite(rule.value) && rule.value > 0)
    .map(rule => ({
      id: rule.id,
      type: rule.type,
      value: rule.value,
      label: rule.type === 'priceAbove' ? '涨到价' : '跌到价',
      priceText: fmt.number(rule.value, precision),
      differenceText: validPrice ? fmt.signed(rule.value - price, precision) : '--',
      distanceText: validPrice ? fmt.signed((rule.value - price) / price * 100) + '%' : '--',
      inRange: range ? rule.value >= range.min && rule.value <= range.max : null,
    }));
}

// Input dates are exchange-local civil dates from the daily endpoint, never device-local instants.
function aggregateCandles(candles, granularity = 'day', today = new Date().toISOString().slice(0, 10)) {
  if (granularity === 'day') return candles.slice();
  const groups = [];
  for (const bar of candles) {
    const civil = bar.time.slice(0, 10);
    const date = new Date(civil + 'T00:00:00Z');
    if (!Number.isFinite(date.getTime())) continue;
    let key, end;
    if (granularity === 'week') {
      date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7);
      key = date.toISOString().slice(0, 10);
      date.setUTCDate(date.getUTCDate() + 6);
      end = date.toISOString().slice(0, 10);
    } else {
      key = civil.slice(0, 7) + '-01';
      end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
    }
    let row = groups[groups.length - 1];
    if (!row || row.time !== key) {
      const startIncomplete = groups.length === 0 && civil > key;
      const endIncomplete = end >= today;
      row = { time: key, o: bar.o, h: bar.h, l: bar.l, c: bar.c,
        v: validVolume(bar.v) ? bar.v : null, startTime: civil, endTime: civil,
        startIncomplete, endIncomplete, partial: startIncomplete || endIncomplete };
      groups.push(row);
    } else {
      row.h = Math.max(row.h, bar.h); row.l = Math.min(row.l, bar.l); row.c = bar.c;
      row.v = validVolume(row.v) && validVolume(bar.v) ? row.v + bar.v : null;
      row.endTime = civil;
    }
  }
  return groups;
}
function validVolume(value) { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function volumeAverage(candles, period) {
  return candles.map((bar, i) => {
    const window = candles.slice(i - period + 1, i + 1);
    return i >= period - 1 && window.every(b => validVolume(b.v))
      ? window.reduce((sum, b) => sum + b.v, 0) / period : null;
  });
}
function bollinger(candles, period = 20, multiplier = 2) {
  const means = movingAverage(candles, period);
  return means.map((middle, i) => {
    if (middle == null) return null;
    const deviation = Math.sqrt(candles.slice(i - period + 1, i + 1)
      .reduce((sum, b) => sum + (b.c - middle) ** 2, 0) / period);
    return { middle, upper: middle + multiplier * deviation, lower: middle - multiplier * deviation };
  });
}
function chartView(candles, settings, viewport = {}) {
  const count = Math.max(1, Math.min(candles.length || 1, Math.round(viewport.count || candles.length || 1)));
  const offset = Math.max(0, Math.min(Math.max(0, candles.length - count), Math.round(viewport.offset || 0)));
  const end = candles.length - offset, start = Math.max(0, end - count);
  const slice = rows => rows.slice(start, end);
  return { bars: candles.slice(start, end), start, end, count, offset, total: candles.length,
    indicators: { ma: Object.fromEntries(settings.maPeriods.map(n => [n, slice(movingAverage(candles, n))])),
      macd: slice(macd(candles)), boll: slice(bollinger(candles)),
      volumeMa: { 5: slice(volumeAverage(candles, 5)), 10: slice(volumeAverage(candles, 10)) } } };
}
module.exports = { DEFAULT_SETTINGS, STORAGE_KEY, movingAverage, macd, parseSettings, chartRange, targets, aggregateCandles, bollinger, volumeAverage, chartView };
