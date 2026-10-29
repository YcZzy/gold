/**
 * Canvas 2D 行情图（无第三方依赖）
 * - render(candles):      日/周/月 K 线（蜡烛 + MA5/MA10 + 成交量）
 * - renderIntraday(pts):  当日分时（价格线 + 均价线 + 昨收参考线 + 成交量）
 * 共用：网格、坐标轴、十字光标、最新价标签；涨红跌绿（A 股惯例）
 *
 * 用法：
 *   const chart = createKlineChart({ canvas, ctx, width, height });
 *   chart.render(candles);                    // [{time,o,h,l,c,v}]
 *   chart.renderIntraday(points, prevClose);  // [{time,price,avg,v}]
 *   chart.touchAt(x);                         // 返回命中的 bar 或 null
 *   chart.clearTouch();
 */

const features = require('./chart-features');

// 默认配色（纸感浅色主题）；黑金等主题通过 createKlineChart({ colors }) / chart.setColors() 覆盖
const DEFAULT_COLORS = {
  up: "#d0453b", // 涨：红
  down: "#2f9e62", // 跌：绿
  upFill: "rgba(208,69,59,0.85)",
  downFill: "rgba(47,158,98,0.85)",
  upArea: "rgba(208,69,59,0.10)",
  downArea: "rgba(47,158,98,0.10)",
  grid: "rgba(44,44,42,0.08)",
  axisText: "#9b968c",
  ma5: "#3e7bd6",
  ma10: "#d98f2b",
  cross: "rgba(44,44,42,0.45)",
  last: "#b0768c",
  volUp: "rgba(208,69,59,0.35)",
  volDown: "rgba(47,158,98,0.35)",
  baseline: "rgba(44,44,42,0.35)"
};

function niceStep(range, tickCount) {
  const raw = range / tickCount;
  const pow = Math.pow(10, Math.floor(Math.log10(raw || 1)));
  const norm = raw / pow;
  let step;
  if (norm <= 1) step = 1;
  else if (norm <= 2) step = 2;
  else if (norm <= 5) step = 5;
  else step = 10;
  return step * pow;
}

function createKlineChart(opts) {
  const canvas = opts.canvas;
  const ctx = opts.ctx;
  const width = opts.width;
  const height = opts.height;
  let palette = Object.assign({}, DEFAULT_COLORS, opts.colors || {});
  let precision = Number.isInteger(opts.precision) ? opts.precision : null;
  function priceText(value) { return value.toFixed(precision == null ? (value >= 1000 ? 0 : 1) : precision); }

  const padLeft = 8;
  const padRight = 56;
  const padTop = 12;
  const padBottom = 20;
  const gap = 8;
  const plotW = width - padLeft - padRight;
  const totalH = height - padTop - padBottom;
  let volH = Math.round(totalH * 0.16);
  let priceH = totalH - volH - gap;

  let mode = "candle"; // 'candle' | 'intraday'
  let bars = []; // 统一的渲染数据（candle 或 intraday 形态）
  let indicators = features.parseSettings(features.DEFAULT_SETTINGS);
  let targetLines = [];
  let minP = 0;
  let maxP = 0;
  let maxV = 1;
  let step = 0;
  let focusIndex = -1;
  let prevClose = null;
  let hasVolume = true;
  let hasMacd = false;
  let naturalRange = null;
  let indicatorRows = null;

  function xAt(i) {
    return padLeft + step * (i + 0.5);
  }

  function yAt(p) {
    return padTop + priceH - ((p - minP) / (maxP - minP || 1)) * priceH;
  }

  function computeRange() {
    naturalRange = features.chartRange(bars, mode, prevClose);
    hasMacd = mode === 'candle' && indicators.subIndicator === 'macd';
    volH = Math.round(totalH * (hasMacd ? 0.26 : 0.16));
    priceH = totalH - volH - gap;
    minP = Infinity;
    maxP = -Infinity;
    maxV = 1;
    for (const b of bars) {
      const lo = mode === "candle" ? b.l : b.price;
      const hi = mode === "candle" ? b.h : b.price;
      if (lo < minP) minP = lo;
      if (hi > maxP) maxP = hi;
      if (b.v > maxV) maxV = b.v;
    }
    if (mode === "intraday" && prevClose != null) {
      if (prevClose < minP) minP = prevClose;
      if (prevClose > maxP) maxP = prevClose;
    }
    if (mode === 'candle' && indicatorRows) {
      if (indicators.bollEnabled) indicatorRows.boll.forEach(row => {
        if (!row) return;
        minP = Math.min(minP, row.lower); maxP = Math.max(maxP, row.upper);
      });
      if (indicators.maEnabled) indicators.maPeriods.forEach(period =>
        (indicatorRows.ma[period] || []).forEach(value => {
          if (value != null) { minP = Math.min(minP, value); maxP = Math.max(maxP, value); }
        }));
      if (indicators.volumeMaEnabled) Object.values(indicatorRows.volumeMa).forEach(rows =>
        rows.forEach(value => { if (value != null) maxV = Math.max(maxV, value); }));
    }
    const pad = (maxP - minP) * 0.06 || maxP * 0.01 || 1;
    minP -= pad;
    maxP += pad;
    hasVolume = bars.some(b => typeof b.v === 'number' && Number.isFinite(b.v) && b.v >= 0);
  }

  function priceAreaHeight() {
    return hasVolume || hasMacd ? priceH : totalH;
  }

  function yAtP(p) {
    return padTop + priceAreaHeight() - ((p - minP) / (maxP - minP || 1)) * priceAreaHeight();
  }

  // ---------- 公共绘制 ----------

  function drawGrid() {
    ctx.strokeStyle = palette.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = palette.axisText;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    const ticks = 4;
    const stepP = niceStep(maxP - minP, ticks);
    const start = Math.ceil(minP / stepP) * stepP;
    for (let p = start; p <= maxP; p += stepP) {
      const y = yAtP(p);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();
      ctx.fillText(priceText(p), padLeft + plotW + 6, y);
    }
    ctx.setLineDash([]);

    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelCount = Math.min(5, bars.length);
    for (let j = 0; j < labelCount; j++) {
      const i = Math.round((j * (bars.length - 1)) / Math.max(1, labelCount - 1));
      const x = xAt(i);
      const t = bars[i].time;
      let label;
      if (mode === "intraday") label = t.slice(t.indexOf(" ") + 1); // HH:MM
      else label = t.length > 7 ? t.slice(2) : t;
      ctx.fillText(label, x, padTop + priceAreaHeight() + gap + (hasVolume || hasMacd ? volH : 0) + 4);
    }
  }

  function drawVolume() {
    if (!hasVolume || hasMacd) return;
    const baseY = padTop + priceH + gap + volH;
    const w = Math.max(1, step * 0.55);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const up = mode === "candle" ? b.c >= b.o : b.price >= (bars[i - 1] ? bars[i - 1].price : b.price);
      if (typeof b.v !== 'number' || !Number.isFinite(b.v) || b.v < 0) continue;
      const h = maxV ? (b.v / maxV) * volH : 0;
      ctx.fillStyle = up ? palette.volUp : palette.volDown;
      ctx.fillRect(xAt(i) - w / 2, baseY - h, w, h);
    }
    if (mode === 'candle' && indicators.volumeMaEnabled) {
      for (const [period, color] of [[5, palette.ma5], [10, palette.ma10]]) {
        const rows = indicatorRows.volumeMa[period];
        ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
        let started = false;
        rows.forEach((v, i) => {
          if (v == null) { started = false; return; }
          const y = baseY - v / maxV * volH;
          if (started) ctx.lineTo(xAt(i), y); else ctx.moveTo(xAt(i), y);
          started = true;
        });
        ctx.stroke();
      }
      ctx.fillStyle = palette.axisText; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('量 MA5 / MA10', padLeft, baseY - volH);
    }
  }

  function drawLastLine(lastPrice, color) {
    const y = yAtP(lastPrice);
    const text = priceText(lastPrice);
    ctx.strokeStyle = color;
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPriceTag(text, y, color);
  }

  function drawPriceTag(text, y, color) {
    ctx.fillStyle = color;
    ctx.fillRect(padLeft + plotW + 2, y - 8, padRight - 6, 16);
    ctx.fillStyle = "#fff";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, padLeft + plotW + 2 + (padRight - 6) / 2, y);
  }

  function drawCross(i, price) {
    const x = xAt(i);
    const y = yAtP(price);
    ctx.strokeStyle = palette.cross;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + priceAreaHeight() + gap + (hasVolume || hasMacd ? volH : 0));
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPriceTag(priceText(price), y, palette.cross);
  }

  // ---------- K 线模式 ----------

  function renderCandles(list, focus, prepared) {
    indicatorRows = prepared || features.chartView(list || [], indicators).indicators;
    mode = "candle";
    bars = list || [];
    focusIndex = typeof focus === "number" ? focus : -1;
    ctx.clearRect(0, 0, width, height);
    if (!bars.length) return;

    computeRange();
    step = plotW / bars.length;

    drawGrid();
    drawVolume();
    if (hasMacd) drawMacd();
    drawCandles();
    if (indicators.maEnabled) indicators.maPeriods.forEach((period, i) =>
      drawMA(indicatorRows.ma[period] || features.movingAverage(bars, period), [palette.ma5, palette.ma10, palette.last][i]));
    if (indicators.bollEnabled) {
      for (const [key, color] of [['upper', palette.ma5], ['middle', palette.last], ['lower', palette.ma10]])
        drawMA(indicatorRows.boll.map(row => row && row[key]), color);
      ctx.fillStyle = palette.axisText; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('BOLL(20,2)', padLeft, padTop + 8);
    }
    drawTargets();
    drawLastLine(bars[bars.length - 1].c, palette.last);
    if (focusIndex >= 0 && focusIndex < bars.length) drawCross(focusIndex, bars[focusIndex].c);
  }

  function drawCandles() {
    const w = Math.max(1, step * 0.62);
    for (let i = 0; i < bars.length; i++) {
      const k = bars[i];
      const up = k.c >= k.o;
      const color = up ? palette.up : palette.down;
      const x = xAt(i);
      ctx.strokeStyle = color;
      ctx.fillStyle = up ? palette.upFill : palette.downFill;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, yAtP(k.h));
      ctx.lineTo(x, yAtP(k.l));
      ctx.stroke();
      const yO = yAtP(k.o);
      const yC = yAtP(k.c);
      ctx.fillRect(x - w / 2, Math.min(yO, yC), w, Math.max(1, Math.abs(yO - yC)));
    }
  }

  function drawMA(values, color) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < values.length; i++) {
      const v = values[i];
      if (v == null) continue;
      const x = xAt(i);
      const y = yAtP(v);
      if (!started) {
        ctx.moveTo(x, y);
        started = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  }

  function drawTargets() {
    if (!naturalRange) return;
    const usedLabels = [];
    for (const target of targetLines) {
      if (target.value < naturalRange.min || target.value > naturalRange.max) continue;
      const y = yAtP(target.value);
      const color = target.type === 'priceAbove' ? palette.ma5 : palette.ma10;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(padLeft, y);
      ctx.lineTo(padLeft + plotW, y);
      ctx.stroke();
      ctx.setLineDash([]);
      // Keep text inside the plot and separate close upper/lower target labels.
      let labelY = Math.max(padTop + 8, Math.min(padTop + priceAreaHeight() - 8, y - 8));
      if (usedLabels.some(previous => Math.abs(previous - labelY) < 16))
        labelY = labelY + 18 <= padTop + priceAreaHeight() - 8 ? labelY + 18 : labelY - 18;
      usedLabels.push(labelY);
      ctx.font = '10px sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = color;
      ctx.fillText((target.type === 'priceAbove' ? '涨到 ' : '跌到 ') + priceText(target.value), padLeft + 4, labelY);
    }
  }

  function drawMacd() {
    const rows = indicatorRows.macd;
    const top = padTop + priceH + gap;
    const innerTop = top + 13;
    const innerHeight = Math.max(8, volH - 15);
    const values = rows.flatMap(row => [row.dif, row.dea, row.histogram]);
    const extent = Math.max(0.000001, ...values.map(Math.abs));
    const yOf = value => innerTop + innerHeight / 2 - value / extent * innerHeight / 2;
    const zero = yOf(0);
    ctx.strokeStyle = palette.grid;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(padLeft, zero);
    ctx.lineTo(padLeft + plotW, zero);
    ctx.stroke();
    ctx.setLineDash([]);
    rows.forEach((row, i) => {
      ctx.fillStyle = row.histogram >= 0 ? palette.volUp : palette.volDown;
      const y = yOf(row.histogram);
      ctx.fillRect(xAt(i) - Math.max(1, step * 0.55) / 2, Math.min(y, zero), Math.max(1, step * 0.55), Math.max(0.5, Math.abs(y - zero)));
    });
    for (const [key, color] of [['dif', palette.ma5], ['dea', palette.ma10]]) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      rows.forEach((row, i) => {
        if (i === 0) ctx.moveTo(xAt(i), yOf(row[key]));
        else ctx.lineTo(xAt(i), yOf(row[key]));
      });
      ctx.stroke();
    }
    ctx.fillStyle = palette.axisText;
    ctx.font = '9px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('MACD(12,26,9)', padLeft, top);
    ctx.fillText('0', padLeft + plotW + 6, zero);
  }

  // ---------- 分时模式 ----------

  function renderIntraday(points, close, focus) {
    mode = "intraday";
    bars = points || [];
    prevClose = close == null ? null : close;
    focusIndex = typeof focus === "number" ? focus : -1;
    ctx.clearRect(0, 0, width, height);
    if (!bars.length) return;

    computeRange();
    step = plotW / bars.length;

    drawGrid();
    drawVolume();
    if (prevClose != null) drawBaseline();
    drawPriceArea();
    drawTargets();
    if (focusIndex >= 0 && focusIndex < bars.length) drawCross(focusIndex, bars[focusIndex].price);
    else drawLastLine(bars[bars.length - 1].price, lineColor());
  }

  function lineColor() {
    const last = bars[bars.length - 1].price;
    const base = prevClose != null ? prevClose : bars[0].price;
    if (last > base) return palette.up;
    if (last < base) return palette.down;
    return palette.last;
  }

  function drawBaseline() {
    const y = yAtP(prevClose);
    ctx.strokeStyle = palette.baseline;
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPriceTag(priceText(prevClose), y, palette.baseline);
  }

  function drawPriceArea() {
    const color = lineColor();
    const fill = color === palette.up ? palette.upArea : palette.downArea;
    const y0 = prevClose != null ? yAtP(prevClose) : padTop + priceAreaHeight();

    // 面积填充（价格与昨收之间）
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(xAt(0), y0);
    for (let i = 0; i < bars.length; i++) ctx.lineTo(xAt(i), yAtP(bars[i].price));
    ctx.lineTo(xAt(bars.length - 1), y0);
    ctx.closePath();
    ctx.fill();

    // 价格线
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let i = 0; i < bars.length; i++) {
      const x = xAt(i);
      const y = yAtP(bars[i].price);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // 均价线（沪金有、伦敦金无）
    if (bars[0].avg != null) {
      ctx.strokeStyle = palette.ma10;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < bars.length; i++) {
        const v = bars[i].avg;
        if (v == null) continue;
        const x = xAt(i);
        const y = yAtP(v);
        if (!started) {
          ctx.moveTo(x, y);
          started = true;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  // ---------- 交互 ----------

  function touchAt(clientX) {
    if (!bars.length) return null;
    const i = Math.max(0, Math.min(bars.length - 1, Math.floor((clientX - padLeft) / step)));
    if (mode === "intraday") renderIntraday(bars, prevClose, i);
    else renderCandles(bars, i, indicatorRows);
    focusIndex = i;
    return bars[i];
  }

  function clearTouch() {
    if (focusIndex >= 0) {
      if (mode === "intraday") renderIntraday(bars, prevClose, -1);
      else renderCandles(bars, -1, indicatorRows);
    }
    focusIndex = -1;
  }

  /** 切换配色并按当前数据重绘（用于主题切换） */
  function setColors(patch) {
    palette = Object.assign({}, palette, patch || {});
    if (bars.length) {
      if (mode === "intraday") renderIntraday(bars, prevClose, focusIndex);
      else renderCandles(bars, focusIndex, indicatorRows);
    }
  }

  return {
    render: renderCandles,
    renderIntraday,
    touchAt,
    clearTouch,
    setColors,
    setIndicators(value) { indicators = features.parseSettings(value); },
    setTargets(value) {
      targetLines = (Array.isArray(value) ? value : []).filter(t =>
        ['priceAbove', 'priceBelow'].includes(t.type) && Number.isFinite(t.value) && t.value > 0)
        .map(t => ({ type: t.type, value: t.value }));
    },
    setPrecision(value) { precision = Number.isInteger(value) && value >= 0 && value <= 6 ? value : null; }
  };
}

module.exports = { createKlineChart };
