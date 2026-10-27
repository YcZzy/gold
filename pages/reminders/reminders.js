const statusClient = require("../../utils/status-client");
const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
const { templates } = require("../../utils/app-config");
const TPL_IDS = [templates.dailyBrief, templates.volatility];
Page({
  data: {
    theme: "paper",
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
  onShow() {
    this._alive = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    return this.reload();
  },
  onUnload() {
    this._alive = false;
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
      this.setData({
        hasPortfolio: true,
        groups: [...s.items, ...removed]
          .map((a) => ({
            ...a,
            rules: (s.rules || [])
              .filter((r) => r.assetId === a.id)
              .map((r) => ({ ...r, summary: fmt.summary(r, a) })),
          }))
          .filter((a) => a.rules.length),
        activeCount: (s.rules || []).filter((r) => r.enabled).length,
        limits: s.limits,
        errorText: "",
        loading: false,
      });
    } catch (e) {
      if (this._alive) this.setData({ loading: false });
    }
    return this.refreshAuth();
  },
  async refreshAuth() {
    try {
      const r = await statusClient.getStatus(wx);
      if (!r || !r.ok) throw Error("授权状态获取失败");
      if (this._alive)
        this.setData({
          hasStatus: true,
          recent: (r.recentTasks || []).slice(0, 5).map(fmt.task),
          quota: {
            brief: Number((r.remaining || {})[templates.dailyBrief] || 0),
            vol: Number((r.remaining || {})[templates.volatility] || 0),
          },
          remaining: TPL_IDS.reduce(
            (n, id) => n + Number((r.remaining || {})[id] || 0),
            0,
          ),
        });
    } catch (e) {
      // Keep the previous quota and recent reminders.
    }
  },
  openAsset(e) {
    wx.navigateTo({
      url:
        "/pages/asset-alert/asset-alert?assetId=" +
        encodeURIComponent(e.currentTarget.dataset.id),
    });
  },
  onAuthTap() {
    if (this.data.authBusy) return;
    this.setData({ authBusy: true, errorText: "" });
    wx.requestSubscribeMessage({
      tmplIds: TPL_IDS,
      success: async (results) => {
        const filtered = {};
        TPL_IDS.forEach((id) => {
          if (results[id]) filtered[id] = results[id];
        });
        try {
          const requestId =
            "auth-" +
            Date.now().toString(36) +
            "-" +
            Math.random().toString(36).slice(2);
          const out = (
            await wx.cloud.callFunction({
              name: "registerAuth",
              data: { requestId, results: filtered },
            })
          ).result;
          if (!out || !out.ok) throw Error("授权登记失败，请重试");
          statusClient.updateStatus(wx, out);
          if (this._alive) {
            this.setData({
              quota: {
                brief: Number((out.remaining || {})[templates.dailyBrief] || 0),
                vol: Number((out.remaining || {})[templates.volatility] || 0),
              },
              remaining: TPL_IDS.reduce(
                (n, id) => n + Number((out.remaining || {})[id] || 0),
                0,
              ),
            });
            wx.showToast({
              title: TPL_IDS.some((id) => filtered[id] === "accept")
                ? "授权已增加"
                : "本次未授权",
              icon: "none",
            });
          }
        } catch (e) {
          if (this._alive) this.setData({ errorText: e.message });
        } finally {
          if (this._alive) this.setData({ authBusy: false });
        }
      },
      fail: () => {
        if (this._alive)
          this.setData({
            authBusy: false,
            errorText: "订阅授权未完成，请重试",
          });
      },
    });
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
