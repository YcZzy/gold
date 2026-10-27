// 精确品种的独立黄金历史数据：上金所 Au99.99 / 新浪伦敦金 XAU。
// 全程解析数据，不执行供应商 JSONP 中的 JavaScript。
function parseGoldHistory(raw, asset, period, now = Date.now()) {
  const months = { "1mo": 1, "3mo": 3, "1y": 12, "5y": 60 }[period];
  if (!months || !["gold-au9999", "gold-xauusd"].includes(asset.id)) throw Error("不支持的黄金历史查询");
  let payload = raw;
  if (Buffer.isBuffer(payload)) payload = payload.toString("utf8");
  let rows, source;
  if (asset.id === "gold-au9999") {
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (!payload || !Array.isArray(payload.time)) throw Error("上金所历史响应无效");
    rows = payload.time.map(row => ({ date: row[0], open: row[1], close: row[2], low: row[3], high: row[4], volume: 0 }));
    source = "sge";
  } else {
    if (typeof payload !== "string") throw Error("伦敦金历史响应无效");
    const begin = payload.indexOf("["), end = payload.lastIndexOf("]");
    if (begin < 0 || end <= begin) throw Error("伦敦金历史响应无效");
    rows = JSON.parse(payload.slice(begin, end + 1));
    if (!Array.isArray(rows)) throw Error("伦敦金历史响应无效");
    source = "sina";
  }
  const shifted = new Date(now + 8 * 3600000);
  const today = shifted.toISOString().slice(0, 10);
  // 日历月范围；月末日期夹到目标月最后一天。
  const targetDay = shifted.getUTCDate();
  shifted.setUTCDate(1);
  shifted.setUTCMonth(shifted.getUTCMonth() - months);
  const lastDay = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, 0)).getUTCDate();
  shifted.setUTCDate(Math.min(targetDay, lastDay));
  const start = shifted.toISOString().slice(0, 10);
  const candles = [];
  for (const row of rows) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(row.date || "")) throw Error("黄金历史日期无效");
    if (row.date < start || row.date > today) continue;
    const time = Date.parse(row.date + "T00:00:00+08:00");
    if (!Number.isFinite(time) || new Date(time + 8 * 3600000).toISOString().slice(0, 10) !== row.date) throw Error("黄金历史日期无效");
    const [o, c, h, l] = [row.open, row.close, row.high, row.low].map(Number);
    if (![o, c, h, l].every(n => Number.isFinite(n) && n > 0) || h < Math.max(o, c, l) || l > Math.min(o, c, h)) throw Error("黄金历史价格无效");
    const volume = Number(row.volume);
    candles.push({ time: row.date, o, c, h, l, v: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
  }
  candles.sort((a, b) => a.time.localeCompare(b.time));
  if (!candles.length || new Set(candles.map(row => row.time)).size !== candles.length) throw Error("暂无有效黄金历史数据");
  return {
    mode: "candle", candles, prevClose: null, source,
    sourceTime: Date.parse(candles[candles.length - 1].time + "T00:00:00+08:00"),
    fetchedAt: now, stale: false
  };
}
function parseGoldIntraday(raw, asset, now = Date.now()) {
  let payload = Buffer.isBuffer(raw) ? raw.toString("utf8") : raw;
  let points = [], prevClose = null, source;
  if (asset.id === "gold-au9999") {
    if (typeof payload === "string") payload = JSON.parse(payload);
    if (!payload || payload.heyue !== "Au99.99" || !Array.isArray(payload.times) || !Array.isArray(payload.data)) throw Error("上金所分时响应无效");
    const match = /^(\d{4})年(\d{1,2})月(\d{1,2})日\s+(\d{2}):(\d{2}):(\d{2})$/.exec(payload.delaystr || "");
    if (!match) throw Error("上金所更新时间无效");
    const date = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
    const updatedAt = Date.parse(`${date}T${match[4]}:${match[5]}:${match[6]}+08:00`);
    if (!Number.isFinite(updatedAt) || updatedAt > now + 60000) throw Error("上金所更新时间无效");
    const currentMinute = Number(match[4]) * 60 + Number(match[5]);
    for (let i = 0; i < payload.times.length; i++) {
      const label = payload.times[i];
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(label)) continue;
      const [h, m] = label.split(":").map(Number);
      const minute = h * 60 + m, price = Number(payload.data[i]);
      if (minute > currentMinute || !Number.isFinite(price) || price <= 0) continue;
      // 图表含跨日时段和未来占位；只使用能由更新日期明确确定的当前日/夜段。
      if (currentMinute < 18 * 60 ? minute >= 18 * 60 : minute < 18 * 60) continue;
      points.push({ time: `${date} ${label}`, price, avg: null, v: 0 });
    }
    source = "sge";
  } else if (asset.id === "gold-xauusd") {
    if (typeof payload === "string") {
      const begin = payload.indexOf("{"), end = payload.lastIndexOf("}");
      if (begin < 0 || end <= begin) throw Error("伦敦金分时响应无效");
      payload = JSON.parse(payload.slice(begin, end + 1));
    }
    if (!payload || !Array.isArray(payload.minLine_1d)) throw Error("伦敦金分时响应无效");
    for (const row of payload.minLine_1d) {
      if (!Array.isArray(row)) continue;
      const first = /^\d{4}-\d{2}-\d{2}$/.test(row[0] || "");
      const stamp = row[row.length - 1];
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp || "")) continue;
      const time = Date.parse(stamp.replace(" ", "T") + "+08:00");
      const price = Number(row[first ? 5 : 1]);
      if (!Number.isFinite(time) || time > now + 60000 || !Number.isFinite(price) || price <= 0) continue;
      if (first && Number(row[1]) > 0) prevClose = Number(row[1]);
      const avg = Number(row[first ? 8 : 4]), volume = Number(row[first ? 6 : 2]);
      points.push({ time: stamp.slice(0, 16), price, avg: Number.isFinite(avg) && avg > 0 ? avg : null, v: Number.isFinite(volume) && volume >= 0 ? volume : 0 });
    }
    source = "sina";
  } else throw Error("不支持的黄金分时查询");
  points.sort((a, b) => a.time.localeCompare(b.time));
  const unique = [...new Map(points.map(point => [point.time, point])).values()];
  if (!unique.length) throw Error("暂无有效黄金分时数据");
  return {
    mode: "intraday", points: unique, prevClose, source,
    sourceTime: Date.parse(unique[unique.length - 1].time.replace(" ", "T") + ":00+08:00"),
    fetchedAt: now, stale: false
  };
}
module.exports = { parseGoldHistory, parseGoldIntraday };
