const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseGoldHistory, parseGoldIntraday } = require("../cloudfunctions/marketData/gold-history");
const now = Date.parse("2026-10-27T15:13:00+08:00");
test("SGE uses exact Au99.99 historical OHLC order and the requested date range", () => {
  const raw = { time: [["2026-08-01", 800, 802, 798, 805], ["2026-10-26", 865, 861.41, 855, 872.99]] };
  const chart = parseGoldHistory(raw, { id: "gold-au9999" }, "1mo", now);
  assert.equal(chart.source, "sge");
  assert.equal(chart.candles.length, 1);
  assert.deepEqual(chart.candles[0], { time: "2026-10-26", o: 865, c: 861.41, l: 855, h: 872.99, v: 0 });
  assert.equal(chart.sourceTime, Date.parse("2026-10-26T00:00:00+08:00"));
});
test("Sina XAU historical JSONP is parsed without eval and cannot become another gold instrument", () => {
  const raw = '/*<script>untrusted();</script>*/\nvar _daily=([{"date":"2026-10-26","open":"4000","close":"4010","high":"4020","low":"3990","volume":"0"}]);';
  const chart = parseGoldHistory(raw, { id: "gold-xauusd" }, "1mo", now);
  assert.equal(chart.source, "sina");
  assert.equal(chart.candles[0].c, 4010);
  assert.throws(() => parseGoldHistory(raw, { id: "gold-au9999" }, "1mo", now));
});
test("error bodies, future dates, reversed OHLC and unsupported periods are rejected", () => {
  for (const raw of [{ time: [["2026-10-28", 800, 802, 798, 805]] }, { time: [["2026-10-26", 800, 900, 798, 805]] }, { error: true }]) {
    assert.throws(() => parseGoldHistory(raw, { id: "gold-au9999" }, "1mo", now));
  }
  assert.throws(() => parseGoldHistory({ time: [] }, { id: "sh600519" }, "1mo", now));
  assert.throws(() => parseGoldHistory({ time: [] }, { id: "gold-au9999" }, "intraday", now));
});

test("SGE intraday binds the actual update date and excludes future placeholders and ambiguous prior-night dates", () => {
  const raw = { heyue: "Au99.99", delaystr: "2026年10月27日 15:12:30", times: ["20:00", "00:00", "09:00", "15:13"], data: [800, 850, 860, 1] };
  const chart = parseGoldIntraday(raw, { id: "gold-au9999" }, now);
  assert.equal(chart.source, "sge");
  assert.deepEqual(chart.points.map(p => p.time), ["2026-10-27 00:00", "2026-10-27 09:00"]);
  assert.equal(chart.sourceTime, Date.parse("2026-10-27T09:00:00+08:00"));
  assert.throws(() => parseGoldIntraday({ ...raw, heyue: "Au(T+D)" }, { id: "gold-au9999" }, now));
});

test("SGE nighttime only uses the explicitly dated current-night segment", () => {
  const at = Date.parse("2026-10-27T21:10:00+08:00");
  const raw = { heyue: "Au99.99", delaystr: "2026年10月27日 21:09:00", times: ["20:00", "21:09", "00:00", "15:00"], data: [860, 862, 800, 1] };
  assert.deepEqual(parseGoldIntraday(raw, { id: "gold-au9999" }, at).points.map(p => p.time), ["2026-10-27 20:00", "2026-10-27 21:09"]);
});

test("Sina XAU minute header and subsequent rows use explicit point timestamps", () => {
  const payload = { minLine_1d: [["2026-10-27", "4016.97", "LIFFE", "", "06:00", "4017.03", "0", "0", "4017.087", "2026-10-27 06:00:00"], ["06:01", "4016.59", "0", "0", "4016.961", "2026-10-27 06:01:00"]] };
  const raw = "var _min=(" + JSON.stringify(payload) + ");";
  const chart = parseGoldIntraday(raw, { id: "gold-xauusd" }, now);
  assert.equal(chart.source, "sina");
  assert.equal(chart.prevClose, 4016.97);
  assert.equal(chart.points[0].price, 4017.03);
  assert.equal(chart.points[1].price, 4016.59);
  assert.equal(chart.points[1].avg, 4016.961);
  assert.throws(() => parseGoldIntraday("var _min=({minLine_1d:[]});", { id: "gold-xauusd" }, now));
});
