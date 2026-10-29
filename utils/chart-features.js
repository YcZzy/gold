const fmt = require('./asset-format');
const DEFAULT_SETTINGS = { maPeriods: [5, 10], maEnabled: true, subIndicator: 'volume' };
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
  return { maPeriods, maEnabled: input.maEnabled, subIndicator: input.subIndicator };
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

module.exports = { DEFAULT_SETTINGS, STORAGE_KEY, movingAverage, macd, parseSettings, chartRange, targets };
