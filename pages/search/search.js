const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
Page({
  data: {
    theme: theme.getTheme(),
    keyword: "",
    results: [],
    history: [],
    loading: false,
    searched: false,
    errorText: "",
    adding: "",
  },
  onLoad() {
    this._alive = true;
    this.setData({
      theme: theme.getTheme(),
      history: wx.getStorageSync("asset-search-history") || [],
    });
    theme.applyChrome(this.data.theme);
  },
  async onShow() {
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    const request = (this._portfolioRequest =
      (this._portfolioRequest || 0) + 1);
    try {
      const result = await portfolio.list();
      if (!this._alive || request !== this._portfolioRequest) return;
      this._followed = new Set(result.items.map((asset) => asset.id));
      this.setData({ results: this.decorate(this.data.results) });
    } catch (error) {
      if (this._alive && request === this._portfolioRequest)
        this.setData({ errorText: "" });
    }
  },
  decorate(assets) {
    return assets.map((asset) => ({
      ...asset,
      ...fmt.identity(asset),
      added: !!(this._followed && this._followed.has(asset.id)),
    }));
  },
  onUnload() {
    this._alive = false;
    clearTimeout(this.timer);
    this._request = (this._request || 0) + 1;
  },
  onInput(e) {
    const keyword = e.detail.value;
    this.setData({ keyword, errorText: "" });
    clearTimeout(this.timer);
    this._request = (this._request || 0) + 1;
    if (!keyword.trim()) {
      this.setData({ results: [], searched: false, loading: false });
      return;
    }
    if (this._composing) return;
    this.timer = setTimeout(() => this.runSearch(keyword), 300);
  },
  onCompositionStart() {
    this._composing = true;
    clearTimeout(this.timer);
  },
  onCompositionEnd(e) {
    this._composing = false;
    this.onInput(e);
  },
  onConfirm() {
    clearTimeout(this.timer);
    return this.runSearch(this.data.keyword);
  },
  async runSearch(keyword) {
    keyword = keyword.trim();
    if (!keyword) return;
    const request = (this._request = (this._request || 0) + 1);
    this.setData({ keyword, loading: true, errorText: "", searched: true });
    try {
      const r = await market.search(keyword);
      if (!this._alive || request !== this._request) return;
      this.setData({
        results: this.decorate((r.assets || r.items || []).slice(0, 8)),
        loading: false,
      });
    } catch (e) {
      if (this._alive && request === this._request)
        this.setData({ loading: false, searched: this.data.results.length > 0, errorText: "" });
    }
  },
  useHistory(e) {
    return this.runSearch(e.currentTarget.dataset.keyword);
  },
  remember() {
    const keyword = this.data.keyword.trim();
    if (!keyword) return;
    const history = [
      keyword,
      ...this.data.history.filter((k) => k !== keyword),
    ].slice(0, 8);
    this.setData({ history });
    wx.setStorageSync("asset-search-history", history);
  },
  preview(e) {
    this.remember();
    wx.navigateTo({
      url:
        "/pages/detail/detail?assetId=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  async addAsset(e) {
    if (this.data.adding) return;
    const id = e.currentTarget.dataset.id;
    this.setData({ adding: id, errorText: "" });
    try {
      const state = await portfolio.add(id);
      this._portfolioRequest = (this._portfolioRequest || 0) + 1;
      this._followed = new Set((state.items || []).map((asset) => asset.id));
      this._followed.add(id);
      if (this._alive) {
        this.remember();
        this.setData({
          results: this.data.results.map((a) => ({
            ...a,
            added: a.id === id || a.added,
          })),
        });
        wx.showToast({ title: "已加入自选", icon: "success" });
      }
    } catch (e) {
      if (this._alive) this.setData({ errorText: e.message });
    } finally {
      if (this._alive) this.setData({ adding: "" });
    }
  },
});
