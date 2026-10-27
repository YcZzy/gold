const cache = require("../../utils/read-cache");
const gold = require("../../utils/gold-api");
const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
const { createKlineChart } = require("../../utils/candle-chart");
Page({
  data: {
    theme: "paper",
    reminderIcon: theme.ICON_BELL_GOLD,
    asset: null,
    quote: fmt.quote(),
    following: false,
    rules: [],
    period: "intraday",
    periods: [
      { value: "intraday", label: "当日" },
      { value: "1mo", label: "1月" },
      { value: "3mo", label: "3月" },
      { value: "1y", label: "1年" },
      { value: "5y", label: "5年" },
    ],
    errorText: "",
    chartError: "",
    chartLoading: false,
    refreshing: false,
    chartSource: "",
    hasChart: false,
    chartHint: "",
    selectedInfo: "",
    intl: null,
    intlError: "",
    busy: false,
  },
  onLoad(options) {
    this.assetId = options.assetId;
    this._alive = true;
    this.bars = [];
    const saved = cache.forPlatform(wx);
    const asset = saved.read("asset:" + this.assetId);
    const quote = saved.read("quote:" + this.assetId);
    if (asset) this.setData({ asset });
    if (quote) this.setData({ quote: fmt.quote(quote.quote, asset || {}) });
  },
  async onShow() {
    this._visible = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    if (this.chart) this.chart.setColors(theme.chartColors(this.data.theme));
    this.stopPolling();
    await this.reload();
    if (this._visible) this.timer = setInterval(() => this.refreshMarket(), 60000);
  },
  onReady() {
    this.initCanvas().then(() => this.redrawChart());
  },
  onHide() {
    this._visible = false;
    this._refreshRequest = (this._refreshRequest || 0) + 1;
    this._intlRequest = (this._intlRequest || 0) + 1;
    this.setData({ refreshing: false, chartLoading: false });
    this.stopPolling();
    this._quoteRequest = (this._quoteRequest || 0) + 1;
    this._chartRequest = (this._chartRequest || 0) + 1;
  },
  onUnload() {
    this._alive = false;
    this.onHide();
  },
  stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  },
  async reload() {
    try {
      const result = await market.resolve(this.assetId);
      if (!this._alive || !this._visible) return;
      const asset = result.asset || result;
      this.setData({ asset, errorText: "" });
      await Promise.all([
        this.refreshMarket(),
        this.loadPortfolio(),
      ]);
    } catch (e) {
      // Keep the previous successful data.
    }
  },
  async refreshMarket() {
    if (this.data.refreshing || !this._visible) return;
    const request = (this._refreshRequest = (this._refreshRequest || 0) + 1);
    this.setData({ refreshing: true });
    try {
      await Promise.all([this.loadQuote(), this.loadChart(), this.loadIntl()]);
    } finally {
      if (this._alive && request === this._refreshRequest) this.setData({ refreshing: false });
    }
  },
  async loadIntl() {
    if (this.assetId !== "gold-au9999") return;
    const request = (this._intlRequest = (this._intlRequest || 0) + 1);
    try {
      const ref = await cache.forPlatform(wx).fetch("intl:gold-au9999", () => gold.getIntlRef(), r => !!(r && r.price != null && r.cnyPerGram != null));
      if (!this._alive || !this._visible || request !== this._intlRequest)
        return;
      this.setData({
        intl: {
          usdText: fmt.number(ref.price),
          cnyText: fmt.number(ref.cnyPerGram),
          rateText: fmt.number(ref.usdCny, 4),
          source: fmt.sourceName(ref.source),
        },
        intlError: "",
      });
    } catch (e) {
      // Preserve the last international reference, including its exchange rate.
    }
  },
  async loadPortfolio() {
    try {
      const s = await portfolio.list();
      if (!this._alive || !this._visible) return;
      this.setData({
        following: s.items.some((a) => a.id === this.assetId),
        rules: (s.rules || [])
          .filter((r) => r.assetId === this.assetId)
          .map((r) => ({ ...r, summary: fmt.summary(r, this.data.asset) })),
      });
    } catch (e) {
      // Keep the previous successful data.
    }
  },
  async loadQuote() {
    const n = (this._quoteRequest = (this._quoteRequest || 0) + 1);
    try {
      const result = await market.quote(this.assetId);
      if (!this._alive || n !== this._quoteRequest) return;
      const q = result.quote || result;
      if (q.price == null || !Number.isFinite(Number(q.price)) || Number(q.price) <= 0 || q.status === "unavailable")
        throw Error("行情暂不可用");
      this.setData({
        quote: fmt.quote(q, this.data.asset || {}),
        errorText: "",
      });
    } catch (e) {
      if (!this._alive || n !== this._quoteRequest) return;
      this.setData({
        quote: fmt.quote({ ...this.data.quote, stale: true, cached: true }, this.data.asset || {}),
        errorText: this.data.quote.price == null ? "行情暂不可用，请稍后刷新" : "",
      });
    }
  },
  async loadChart() {
    const n = (this._chartRequest = (this._chartRequest || 0) + 1);
    const period = this.data.period;
    this.setData({ chartError: "", chartLoading: true });
    try {
      const result = await market.chart(this.assetId, period);
      if (
        !this._alive ||
        n !== this._chartRequest ||
        period !== this.data.period
      )
        return;
      const c = result.chart || result;
      const bars = c.mode === "intraday" || period === "intraday" ? c.points : c.candles;
      if (!Array.isArray(bars) || !bars.length) {
        throw Error("图表数据为空");
      }
      this.bars = bars;
      this._displayPeriod = period;
      this.intradayPrevClose = c.prevClose;
      this.setData({
        hasChart: true,
        selectedInfo: "",
        chartSource: fmt.sourceName(c.source),
        chartError: c.cached ? "图表刷新失败，保留上次图表；可重试或切换周期" : "",
        chartHint: (c.cached ? "缓存图表 · " : c.stale ? "延迟数据 · " : "") + fmt.time(c.sourceTime),
      });
      if (!this.chart && wx.nextTick) {
        wx.nextTick(() => {
          if (!this.chart) this.initCanvas().then(() => this.redrawChart());
          else this.redrawChart();
        });
      } else this.redrawChart();
    } catch (e) {
      if (!this._alive || n !== this._chartRequest) return;
      this.setData({
        ...(this._displayPeriod ? { period: this._displayPeriod } : {}),
        chartError: this._displayPeriod
          ? "图表刷新失败，保留上次图表；可重试或切换周期"
          : "图表暂不可用，请重试或切换周期",
      });
    } finally {
      if (this._alive && n === this._chartRequest) this.setData({ chartLoading: false });
    }
  },
  initCanvas() {
    return new Promise((resolve) => {
      const q = wx.createSelectorQuery().in(this);
      q.select("#kline")
        .fields({ node: true, size: true, rect: true })
        .exec((res) => {
          const i = res && res[0];
          if (i && i.node && this._alive) {
            const canvas = i.node;
            const ctx = canvas.getContext("2d");
            const dpr =
              (wx.getWindowInfo && wx.getWindowInfo().windowPixelRatio) || 2;
            canvas.width = i.width * dpr;
            canvas.height = i.height * dpr;
            ctx.scale(dpr, dpr);
            this.canvasRect = { left: i.left || 0 };
            this.chart = createKlineChart({
              canvas,
              ctx,
              width: i.width,
              height: i.height,
              colors: theme.chartColors(this.data.theme),
            });
          }
          resolve();
        });
    });
  },
  redrawChart() {
    if (!this.chart) return;
    if (this.data.period === "intraday")
      this.chart.renderIntraday(this.bars || [], this.intradayPrevClose);
    else this.chart.render(this.bars || []);
  },
  switchPeriod(e) {
    const period = e.currentTarget.dataset.period;
    if (period === this.data.period && !this.data.chartError) return;
    this.setData({ period });
    return this.loadChart();
  },
  onTouch(e) {
    if (!this.chart || !this.bars.length) return;
    const t = (e.touches || [])[0] || (e.changedTouches || [])[0];
    if (!t) return;
    const hit = this.chart.touchAt(
      t.x == null ? t.clientX - (this.canvasRect || {}).left : t.x,
    );
    if (!hit) return;
    this.setData({
      selectedInfo:
        this.data.period === "intraday"
          ? `${hit.time} · 价 ${fmt.number(hit.price)} · 均 ${fmt.number(hit.avg)}`
          : `${hit.time} · 开 ${fmt.number(hit.o)} 高 ${fmt.number(hit.h)} 低 ${fmt.number(hit.l)} 收 ${fmt.number(hit.c)}`,
    });
  },
  async follow() {
    if (this.data.busy) return false;
    this.setData({ busy: true, errorText: "" });
    try {
      await portfolio.add(this.assetId);
      if (this._alive) this.setData({ following: true });
      return true;
    } catch (e) {
      if (this._alive) this.setData({ errorText: e.message });
      return false;
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
  },
  toggleFollow() {
    if (this.data.busy) return;
    if (!this.data.following) return this.follow();
    wx.showModal({
      title: "删除自选",
      content: "删除后，该标的的全部通知提醒也将一并删除，重新添加不会恢复。确定删除？",
      success: async (r) => {
        if (!r.confirm || this.data.busy) return;
        this.setData({ busy: true });
        try {
          await portfolio.remove(this.assetId);
          if (this._alive) this.setData({ following: false });
          await this.loadPortfolio();
        } catch (e) {
          if (this._alive) this.setData({ errorText: e.message });
        } finally {
          if (this._alive) this.setData({ busy: false });
        }
      },
    });
  },
  openAlert() {
    const go = () =>
      wx.navigateTo({
        url:
          "/pages/asset-alert/asset-alert?assetId=" +
          encodeURIComponent(this.assetId),
      });
    if (this.data.following) return go();
    wx.showModal({
      title: "先加入自选",
      content: "加入自选后才可设置提醒",
      confirmText: "加入自选",
      cancelText: "暂不加入",
      success: async (r) => {
        if (r.confirm && (await this.follow())) go();
      },
      fail: () => {
        if (this._alive) this.setData({
          errorText: "加入自选后才可设置提醒，请先点击右上角「自选」",
        });
      },
    });
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
