const statusClient = require("../../utils/status-client");
const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const cache = require("../../utils/read-cache");
const fmt = require("../../utils/asset-format");
const { templates } = require("../../utils/app-config");
const settings = require("../../utils/reminder-settings")({ market, portfolio, theme, fmt, wx, statusClient, templates });
const TPL_IDS = [templates.dailyBrief, templates.volatility];
Page({
  ...settings,
  data: {
    ...settings.data,
    assets: [],
    assetIndex: 0,
    theme: theme.getTheme(),
    hasStatus: false,
    hasPortfolio: false,
    groups: [],
    recent: [],
    limits: { activeRules: 30 },
    activeCount: 0,
    remaining: 0,
    quota: { brief: 0, vol: 0 },
    errorText: "",
    loading: true,
    authBusy: false,
  },
  onLoad() {
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
  },
  onShow() {
    this._alive = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    if (!this.data.hasPortfolio && portfolio.getCached) {
      const saved = portfolio.getCached();
      if (saved) {
        const removed = [...new Set((saved.rules || []).map(r => r.assetId))]
          .filter(id => !saved.items.some(a => a.id === id))
          .map(id => cache.forPlatform(wx).read("asset:" + id) ||
            { id, name: id, code: id, market: "", unit: "" });
        this.applyPortfolio(saved, removed);
      }
    }
    if (!this.data.hasStatus) {
      const saved = cache.forPlatform(wx).read("status");
      if (saved && saved.ok) this.applyStatus(saved);
    }
    return this.reload();
  },
  onUnload() {
    this._alive = false;
  },
  applyPortfolio(s, removed = []) {
    this._state = s;
    const assets = [...s.items, ...removed];
    this.setData({
      assets,
      hasPortfolio: true,
      groups: [...s.items, ...removed]
        .map(a => ({
          ...a,
          ...fmt.identity(a),
          rules: (s.rules || []).filter(r => r.assetId === a.id)
            .map(r => ({ ...r, summary: fmt.summary(r, a) })),
        }))
        .filter(a => a.rules.length),
      activeCount: (s.rules || []).filter(r => r.enabled).length,
      limits: s.limits,
      errorText: "",
      loading: false,
    });
    if (!this.data.asset && assets.length) this.selectAsset(assets[0].id);
    else if (this.data.asset && !this.data.editing) this.selectAsset(this.assetId);
  },
  applyState(s) {
    const removed = this.data.assets.filter(a => !s.items.some(item => item.id === a.id));
    this.applyPortfolio(s, removed);
    if (this.data.asset) {
      this.setData({ rules: (s.rules || []).filter(r => r.assetId === this.assetId).map(r => ({ ...r, summary: fmt.summary(r, this.data.asset) })), following: s.items.some(a => a.id === this.assetId) });
    }
  },
  selectAsset(id) {
    if (this.data.busy) return;
    const asset = this.data.assets.find(a => a.id === id);
    if (!asset) return;
    this.assetId = id;
    this.setData({
      asset: { ...asset, ...fmt.identity(asset) },
      assetIndex: this.data.assets.findIndex(a => a.id === id),
      types: fmt.TYPES.filter(t => t.value !== 'close' || asset.supportsClose === true ||
        (asset.supportsClose !== false && (asset.market === 'SH' || asset.market === 'SZ' || asset.id === 'gold-au9999'))),
      rules: (this._state.rules || []).filter(r => r.assetId === id).map(r => ({ ...r, summary: fmt.summary(r, asset) })),
      following: this._state.items.some(a => a.id === id),
      editing: false,
      errorText: '',
      statusNote: '',
    });
  },
  onAssetChange(e) {
    const asset = this.data.assets[Number(e.detail.value)];
    if (asset) this.selectAsset(asset.id);
  },
  applyStatus(r) {
    this.syncDnd(r.prefs);
    this.setData({
      hasStatus: true,
      authError: "",
      recent: (r.recentTasks || []).slice(0, 5).map(fmt.task),
      quota: {
        brief: Number((r.remaining || {})[templates.dailyBrief] || 0),
        vol: Number((r.remaining || {})[templates.volatility] || 0),
      },
      remaining: TPL_IDS.reduce((n, id) => n + Number((r.remaining || {})[id] || 0), 0),
    });
  },
  async reload() {
    try {
      const s = await portfolio.list();
      const missing = [
        ...new Set((s.rules || []).map((r) => r.assetId)),
      ].filter((id) => !s.items.some((a) => a.id === id));
      const removed = await Promise.all(
        missing.map(async (id) => {
          try {
            const r = await market.resolve(id);
            return r.asset || r;
          } catch (e) {
            return this.data.groups.find(a => a.id === id) || { id, name: id, code: id, market: "", unit: "" };
          }
        }),
      );
      if (!this._alive) return;
      this.applyPortfolio(s, removed);
    } catch (e) {
      if (this._alive) this.setData({ loading: false });
    }
    if (!this.data.asset && this.data.assets.length) this.selectAsset(this.data.assets[0].id);
    return this.refreshAuth();
  },
  async refreshAuth() {
    try {
      const r = await statusClient.getStatus(wx);
      if (!r || !r.ok) throw Error("授权状态获取失败");
      if (this._alive) this.applyStatus(r);
    } catch (e) {
      if (this._alive) this.setData({ authError: "授权次数获取失败，请点击重试" });
    }
  },
  openAsset(e) {
    this.selectAsset(e.currentTarget.dataset.id);
    if (wx.pageScrollTo) wx.pageScrollTo({ selector: '#inline-settings', duration: 200 });
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
