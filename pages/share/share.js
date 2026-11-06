const share = require("../../utils/share");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const cache = require("../../utils/read-cache");
const openAssetAlert = require("../../utils/open-asset-alert");

function row(id, asset, quote) {
  const identity = asset || {};
  const price = fmt.quote(quote, identity);
  return {
    id,
    name: identity.name || id.toUpperCase(),
    code: identity.code || "",
    market: price.marketText,
    unit: identity.unit || "",
    priceText: price.priceText,
    pctText: price.pctText,
    changeClass: price.changePct > 0 ? "up" : price.changePct < 0 ? "down" : "flat",
    status: quote ? price.statusText : "报价暂缺",
    time: quote && quote.sourceTime ? price.timeText : "",
  };
}

Page({
  data: {
    theme: theme.getTheme(),
    kind: "",
    heading: null,
    rows: [],
    selected: null,
    loading: false,
    invalid: false,
    quoteError: false,
    alertError: "",
    alertId: "",
  },
  onLoad(options) {
    this._share = share.parse(options);
    if (!this._share) {
      this.setData({ invalid: true });
      return;
    }
    const { kind, ids } = this._share;
    const rows = ids.map(id => row(id));
    this.setData({ kind, heading: share.TYPES[kind], rows, selected: kind === "quote" ? rows[0] : null });
    if (ids.length) return this.loadQuotes();
  },
  onShow() {
    this._visible = true;
    const value = theme.getTheme();
    this.setData({ theme: value, bell: value === "blackgold" ? theme.ICON_BELL_GOLD : theme.bellIcon("blackgold") });
    theme.applyChrome(value);
  },
  onHide() { this._visible = false; },
  onUnload() {
    this._visible = false;
    this._disposed = true;
  },
  onPullDownRefresh() {
    return Promise.resolve(this.loadQuotes()).finally(() => wx.stopPullDownRefresh());
  },
  async loadQuotes() {
    const ids = this._share && this._share.ids;
    if (!ids || !ids.length || this.data.loading) return;
    this.setData({ loading: true, quoteError: false });
    const saved = cache.forPlatform(wx);
    try {
      const result = await market.quotes(ids);
      const assets = new Map((result.assets || []).map(asset => [asset.id, asset]));
      const quotes = new Map((result.quotes || []).map(quote => [quote.assetId, quote]));
      const rows = ids.map(id => row(id, assets.get(id) || saved.read("asset:" + id), quotes.get(id)));
      if (!this._disposed) this.setData({
        rows,
        selected: this._share.kind === "quote" ? rows[0] : null,
        quoteError: !quotes.size,
      });
    } catch (error) {
      const rows = ids.map(id => row(id, saved.read("asset:" + id)));
      if (!this._disposed) this.setData({ rows, selected: this._share.kind === "quote" ? rows[0] : null, quoteError: true });
    } finally {
      if (!this._disposed) this.setData({ loading: false });
    }
  },
  openDetail(e) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: "/pages/detail/detail?assetId=" + encodeURIComponent(id) });
  },
  openSearch() {
    wx.navigateTo({ url: "/pages/search/search" });
  },
  openHome() {
    wx.switchTab({ url: "/pages/index/index" });
  },
  async openAlert(e) {
    const assetId = e.currentTarget.dataset.id;
    if (this.data.alertId || !this._share || !this._share.ids.includes(assetId)) return;
    const active = () => this._visible && !this._disposed;
    const onError = alertError => { if (active()) this.setData({ alertError }); };
    this.setData({ alertId: assetId, alertError: "" });
    try {
      const state = await portfolio.list();
      if (!active()) return;
      if (state.offline && !portfolio.getCached()) throw Error("关注状态暂时无法确认，请稍后重试");
      await openAssetAlert(wx, {
        assetId,
        following: state.items.some(asset => asset.id === assetId),
        follow: async () => { await portfolio.add(assetId); return true; },
        active,
        onError,
      });
    } catch (error) {
      onError(error.hint || error.message || "暂时无法打开提醒，请重试");
      if (active() && error.code === "watchlist-limit") require("../../utils/membership-client").offerUpgrade(wx, error);
    } finally {
      if (!this._disposed) this.setData({ alertId: "" });
    }
  },
});
