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

const COLORS = {
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

function movingAverage(candles, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < candles.length; i++) {
    sum += candles[i].c;
    if (i >= n) sum -= candles[i - n].c;
    out.push(i >= n - 1 ? sum / n : null);
  }
  return out;
}

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

  const padLeft = 8;
  const padRight = 56;
  const padTop = 12;
  const padBottom = 20;
  const gap = 8;
  const plotW = width - padLeft - padRight;
  const totalH = height - padTop - padBottom;
  const volH = Math.round(totalH * 0.16);
  const priceH = totalH - volH - gap;

  let mode = "candle"; // 'candle' | 'intraday'
  let bars = []; // 统一的渲染数据（candle 或 intraday 形态）
  let ma5 = [];
  let ma10 = [];
  let minP = 0;
  let maxP = 0;
  let maxV = 1;
  let step = 0;
  let focusIndex = -1;
  let prevClose = null;
  let hasVolume = true;

  function xAt(i) {
    return padLeft + step * (i + 0.5);
  }

  function yAt(p) {
    return padTop + priceH - ((p - minP) / (maxP - minP || 1)) * priceH;
  }

  function computeRange() {
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
    const pad = (maxP - minP) * 0.06 || maxP * 0.01 || 1;
    minP -= pad;
    maxP += pad;
    hasVolume = maxV > 1;
  }

  function priceAreaHeight() {
    return hasVolume ? priceH : totalH;
  }

  function yAtP(p) {
    return padTop + priceAreaHeight() - ((p - minP) / (maxP - minP || 1)) * priceAreaHeight();
  }

  // ---------- 公共绘制 ----------

  function drawGrid() {
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.font = "10px sans-serif";
    ctx.fillStyle = COLORS.axisText;
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
      ctx.fillText(p.toFixed(p >= 1000 ? 0 : 1), padLeft + plotW + 6, y);
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
      ctx.fillText(label, x, padTop + priceAreaHeight() + gap + (hasVolume ? volH : 0) + 4);
    }
  }

  function drawVolume() {
    if (!hasVolume) return;
    const baseY = padTop + priceH + gap + volH;
    const w = Math.max(1, step * 0.55);
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const up = mode === "candle" ? b.c >= b.o : b.price >= (bars[i - 1] ? bars[i - 1].price : b.price);
      const h = maxV ? (b.v / maxV) * volH : 0;
      ctx.fillStyle = up ? COLORS.volUp : COLORS.volDown;
      ctx.fillRect(xAt(i) - w / 2, baseY - h, w, h);
    }
  }

  function drawLastLine(lastPrice, color) {
    const y = yAtP(lastPrice);
    const text = lastPrice.toFixed(lastPrice >= 1000 ? 0 : 1);
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
    ctx.strokeStyle = COLORS.cross;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(x, padTop);
    ctx.lineTo(x, padTop + priceAreaHeight() + gap + (hasVolume ? volH : 0));
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPriceTag(price.toFixed(price >= 1000 ? 0 : 1), y, COLORS.cross);
  }

  // ---------- K 线模式 ----------

  function renderCandles(list, focus) {
    mode = "candle";
    bars = list || [];
    focusIndex = typeof focus === "number" ? focus : -1;
    ctx.clearRect(0, 0, width, height);
    if (!bars.length) return;

    ma5 = movingAverage(bars, 5);
    ma10 = movingAverage(bars, 10);
    computeRange();
    step = plotW / bars.length;

    drawGrid();
    drawVolume();
    drawCandles();
    drawMA(ma5, COLORS.ma5);
    drawMA(ma10, COLORS.ma10);
    drawLastLine(bars[bars.length - 1].c, COLORS.last);
    if (focusIndex >= 0 && focusIndex < bars.length) drawCross(focusIndex, bars[focusIndex].c);
  }

  function drawCandles() {
    const w = Math.max(1, step * 0.62);
    for (let i = 0; i < bars.length; i++) {
      const k = bars[i];
      const up = k.c >= k.o;
      const color = up ? COLORS.up : COLORS.down;
      const x = xAt(i);
      ctx.strokeStyle = color;
      ctx.fillStyle = up ? COLORS.upFill : COLORS.downFill;
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
    if (focusIndex >= 0 && focusIndex < bars.length) drawCross(focusIndex, bars[focusIndex].price);
    else drawLastLine(bars[bars.length - 1].price, lineColor());
  }

  function lineColor() {
    const last = bars[bars.length - 1].price;
    const base = prevClose != null ? prevClose : bars[0].price;
    if (last > base) return COLORS.up;
    if (last < base) return COLORS.down;
    return COLORS.last;
  }

  function drawBaseline() {
    const y = yAtP(prevClose);
    ctx.strokeStyle = COLORS.baseline;
    ctx.setLineDash([5, 3]);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padLeft, y);
    ctx.lineTo(padLeft + plotW, y);
    ctx.stroke();
    ctx.setLineDash([]);
    drawPriceTag(prevClose.toFixed(prevClose >= 1000 ? 0 : 1), y, COLORS.baseline);
  }

  function drawPriceArea() {
    const color = lineColor();
    const fill = color === COLORS.up ? COLORS.upArea : COLORS.downArea;
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
      ctx.strokeStyle = COLORS.ma10;
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
    else renderCandles(bars, i);
    focusIndex = i;
    return bars[i];
  }

  function clearTouch() {
    if (focusIndex >= 0) {
      if (mode === "intraday") renderIntraday(bars, prevClose, -1);
      else renderCandles(bars, -1);
    }
    focusIndex = -1;
  }

  return {
    render: renderCandles,
    renderIntraday,
    touchAt,
    clearTouch
  };
}

module.exports = { createKlineChart };
