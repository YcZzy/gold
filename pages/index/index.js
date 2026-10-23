const api = require("../../utils/gold-api.js");
const { createKlineChart } = require("../../utils/candle-chart.js");

const PERIODS = [
  { label: "当日", value: "intraday" },
  { label: "1月", value: "1mo" },
  { label: "3月", value: "3mo" },
  { label: "1年", value: "1y" },
  { label: "5年", value: "5y" }
];

function fmt(n, d) {
  if (n == null || isNaN(n)) return "--";
  return Number(n).toFixed(d == null ? 2 : d);
}

function fmtChange(n) {
  if (n == null || isNaN(n)) return "--";
  return (n > 0 ? "+" : "") + Number(n).toFixed(2);
}

function clsOf(change) {
  if (change > 0) return "up";
  if (change < 0) return "down";
  return "flat";
}

function fmtTime(ts) {
  const d = new Date(ts || Date.now());
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return hh + ":" + mm + " 更新";
}

Page({
  data: {
    periods: PERIODS,
    period: "intraday",
    au: {
      priceText: "--",
      changeText: "--",
      pctText: "--",
      openText: "--",
      highText: "--",
      lowText: "--",
      cls: "flat",
      source: "--"
    },
    intl: {
      usdText: "--",
      cnyText: "--",
      premiumText: "--",
      rateText: "--",
      source: "--"
    },
    updatedAtText: "--",
    errorText: "",
    candleInfo: null,
    intradayInfo: null,
    chartSource: "--"
  },

  onLoad() {
    this.bars = [];
    this.intradayPrevClose = null;
    this.chart = null;
    this.timer = null;
    this.initCanvas().then(() => this.refreshAll());
    this.timer = setInterval(() => this.loadQuotes(), 60000);
  },

  onUnload() {
    if (this.timer) clearInterval(this.timer);
  },

  onPullDownRefresh() {
    this.refreshAll().finally(() => wx.stopPullDownRefresh());
  },

  initCanvas() {
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery().in(this);
      q.select("#kline")
        .fields({ node: true, size: true, rect: true })
        .exec((res) => {
          const info = res && res[0];
          if (!info || !info.node) {
            resolve();
            return;
          }
          const canvas = info.node;
          const ctx = canvas.getContext("2d");
          const dpr = (wx.getWindowInfo && wx.getWindowInfo().windowPixelRatio) || 2;
          canvas.width = info.width * dpr;
          canvas.height = info.height * dpr;
          ctx.scale(dpr, dpr);
          this.canvasRect = { left: info.left || 0, top: info.top || 0 };
          this.chart = createKlineChart({
            canvas,
            ctx,
            width: info.width,
            height: info.height
          });
          resolve();
        });
    });
  },

  async refreshAll() {
    this.setData({ errorText: "" });
    await Promise.all([this.loadQuotes(), this.loadChart()]);
    this.setData({ updatedAtText: fmtTime(Date.now()) });
  },

  async loadQuotes() {
    const settled = await Promise.allSettled([api.getAuQuote(), api.getIntlRef()]);
    const auRes = settled[0];
    const intlRes = settled[1];
    let auPrice = null;

    if (auRes.status === "fulfilled") {
      const q = auRes.value;
      auPrice = q.price;
      this.setData({
        au: {
          priceText: fmt(q.price),
          changeText: fmtChange(q.change),
          pctText: (q.changePct > 0 ? "+" : "") + fmt(q.changePct) + "%",
          openText: fmt(q.open),
          highText: fmt(q.high),
          lowText: fmt(q.low),
          cls: clsOf(q.change),
          source: q.source
        }
      });
    }

    if (intlRes.status === "fulfilled") {
      const q = intlRes.value;
      let premiumText = "--";
      if (auPrice != null && q.cnyPerGram != null) {
        const gap = auPrice - q.cnyPerGram;
        premiumText = (gap >= 0 ? "升水 +" : "贴水 ") + fmt(gap, 2) + " 元/克";
      }
      this.setData({
        intl: {
          usdText: fmt(q.price, 2),
          cnyText: q.cnyPerGram != null ? fmt(q.cnyPerGram, 2) : "--",
          premiumText,
          rateText: q.usdCny ? "汇率 " + Number(q.usdCny).toFixed(4) : "--",
          source: q.source
        }
      });
    }

    const errs = [];
    if (auRes.status === "rejected") errs.push("沪金");
    if (errs.length) {
      this.setData({ errorText: errs.join("、") + "获取失败，稍后自动重试" });
    }
    this.setData({ updatedAtText: fmtTime(Date.now()) });
  },

  async loadChart() {
    const { period } = this.data;
    try {
      if (period === "intraday") {
        const res = await api.getAuIntraday();
        this.bars = res.points;
        this.intradayPrevClose = res.prevClose;
        this.setData({
          chartSource: res.source + "（含夜盘）",
          candleInfo: null,
          intradayInfo: null
        });
        if (this.chart) this.chart.renderIntraday(res.points, res.prevClose);
      } else {
        const candles = await api.getAuKline(period);
        this.bars = candles;
        this.intradayPrevClose = null;
        this.setData({
          chartSource: "东方财富",
          candleInfo: null,
          intradayInfo: null
        });
        if (this.chart) this.chart.render(candles);
      }
    } catch (e) {
      this.setData({
        errorText: period === "intraday" ? "分时数据获取失败，请稍后重试" : "K 线获取失败，请检查网络或稍后重试"
      });
    }
  },

  openAlert() {
    wx.navigateTo({ url: "/pages/alert/alert" });
  },

  switchPeriod(e) {
    const period = e.currentTarget.dataset.period;
    if (period === this.data.period) return;
    this.setData({ period, candleInfo: null, intradayInfo: null });
    this.loadChart();
  },

  onTouch(e) {
    if (!this.chart || !this.bars.length) return;
    const t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]);
    if (!t) return;
    const x = t.x != null ? t.x : t.clientX - (this.canvasRect ? this.canvasRect.left : 0);
    const hit = this.chart.touchAt(x);
    if (!hit) return;

    if (this.data.period === "intraday") {
      const base = this.intradayPrevClose;
      const pct = base ? ((hit.price - base) / base) * 100 : null;
      this.setData({
        intradayInfo: {
          time: hit.time,
          price: fmt(hit.price),
          avg: hit.avg != null ? fmt(hit.avg) : "--",
          pctText: pct != null ? (pct > 0 ? "+" : "") + fmt(pct) + "%" : "--",
          cls: pct != null ? clsOf(pct) : "flat"
        },
        candleInfo: null
      });
    } else {
      this.setData({
        candleInfo: {
          time: hit.time,
          o: fmt(hit.o),
          h: fmt(hit.h),
          l: fmt(hit.l),
          c: fmt(hit.c)
        },
        intradayInfo: null
      });
    }
  },

  onTouchEnd() {
    // 保留最后选中的信息，方便查看
  }
});
