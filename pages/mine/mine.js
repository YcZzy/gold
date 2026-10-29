const statusClient = require("../../utils/status-client");
const { templates } = require("../../utils/app-config");
const TPL_IDS = [templates.dailyBrief, templates.volatility];
const theme = require("../../utils/theme");
const portfolio = require("../../utils/portfolio-client");
const fmt = require("../../utils/asset-format");
const cache = require("../../utils/read-cache");
Page({
  data: {
    theme: theme.getTheme(),
    hasStatus: false,
    hasPortfolio: false,
    prefs: { dndStart: "23:00", dndEnd: "07:30" },
    limits: { watchlist: 5, activeRules: 30, tier: "free" },
    quota: { brief: 0, vol: 0 },
    authBusy: false,
    busy: false,
    errorText: "",
    loading: true,
    checkBusy: false,
    testBusy: false,
    check: null,
    testResult: "",
  },
  onLoad() {
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
  },
  onShow() {
    this._alive = true;
    this._visible = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    if (!this.data.hasPortfolio && portfolio.getCached) {
      const saved = portfolio.getCached();
      if (saved) this.setData({ hasPortfolio: true, limits: saved.limits });
    }
    if (!this.data.hasStatus) {
      const saved = cache.forPlatform(wx).read("status");
      if (saved && saved.ok) this.applyStatus(saved);
    }
    return this.reload();
  },
  onHide() {
    this._visible = false;
    this._reloadRequest = (this._reloadRequest || 0) + 1;
  },
  onUnload() {
    this._alive = false;
    this.onHide();
  },
  applyStatus(r, patch = {}) {
    // Cached status fills the layout; only a live response may initialize theme.
    this.setData({
      hasStatus: true,
      quota: {
        brief: Number((r.remaining || {})[templates.dailyBrief] || 0),
        vol: Number((r.remaining || {})[templates.volatility] || 0),
      },
      prefs: {
        dndStart: (r.prefs && r.prefs.dndStart) || "23:00",
        dndEnd: (r.prefs && r.prefs.dndEnd) || "07:30",
      },
      ...patch,
    });
  },
  async reload() {
    const request = this._reloadRequest = (this._reloadRequest || 0) + 1;
    try {
      const [s, response] = await Promise.all([
        portfolio.list(),
        statusClient.getStatus(wx),
      ]);
      const r = response;
      if (!r || !r.ok) throw Error("设置获取失败");
      if (this._alive && this._visible && request === this._reloadRequest) {
        this.applyStatus(r, {
          theme: theme.syncFromPrefs(r.prefs),
          hasPortfolio: true,
          limits: s.limits,
          loading: false,
          errorText: "",
        });
      }
    } catch (e) {
      if (this._alive && this._visible && request === this._reloadRequest)
        this.setData({ loading: false });
    }
  },
  onThemeTap() {
    this.setData({
      theme: theme.setTheme(
        this.data.theme === "paper" ? "blackgold" : "paper",
      ),
    });
  },
  async saveDnd(e) {
    if (this.data.busy) return;
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (
      !["dndStart", "dndEnd"].includes(key) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)
    )
      return;
    this.setData({ busy: true, errorText: "" });
    try {
      const r = (
        await wx.cloud.callFunction({
          name: "savePrefs",
          data: { prefs: { [key]: value } },
        })
      ).result;
      if (!r || !r.ok) throw Error((r && r.hint) || "免打扰保存失败");
      statusClient.updateStatus(wx, { ...r, prefs: { ...r.prefs, [key]: value } });
      if (this._alive)
        this.setData({ prefs: { ...this.data.prefs, [key]: value } });
    } catch (e) {
      if (this._alive) this.setData({ errorText: e.message });
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
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

  openAuth() {
    wx.switchTab({ url: "/pages/reminders/reminders" });
  },
  async checkNotifications() {
    if (this.data.checkBusy) return;
    this.setData({ checkBusy: true, check: null });
    try {
      const [response, assets] = await Promise.all([
        wx.cloud.callFunction({ name: "getStatus" }), portfolio.list(),
      ]);
      const status = response && response.result;
      if (!status || !status.ok) throw Error("无法读取提醒状态");
      const prefs = status.prefs || {};
      const rules = assets.rules || [];
      if (this._alive) this.setData({ check: {
        rules: assets.offline ? "暂时无法确认，请联网后重试" : `已开启 ${rules.filter(r => r.enabled).length} 条提醒`,
        quota: `播报 ${Number((status.remaining || {})[templates.dailyBrief] || 0)} 次 · 异动 ${Number((status.remaining || {})[templates.volatility] || 0)} 次`,
        dnd: `${prefs.dndStart || "23:00"} – ${prefs.dndEnd || "07:30"}（北京时间）`,
        recent: (status.recentTasks || []).slice(0, 3).map(fmt.task),
      } });
    } catch (error) {
      if (this._alive) this.setData({ check: { error: "自检失败，请检查网络后重试。" } });
    } finally {
      if (this._alive) this.setData({ checkBusy: false });
    }
  },
  async testNotification() {
    if (this.data.testBusy) return;
    this.setData({ testBusy: true, testResult: "" });
    try {
      const response = await wx.cloud.callFunction({ name: "sendTask", data: { action: "testNotification" } });
      const result = response && response.result;
      if (!result || !result.ok) {
        const messages = {
          "no-quota": "异动授权次数不足，请先增加授权。",
          "send-failed": `发送失败${result && result.code != null ? "（错误码 " + result.code + "）" : ""}，请检查微信订阅设置。`,
          "send-uncertain": "发送结果暂无法确认，请查看最近提醒，避免重复测试。",
        };
        throw Error(messages[result && result.err] || "测试失败，请稍后重试。");
      }
      if (this._alive) this.setData({ testResult: "测试消息已提交微信发送，请留意微信服务通知。" });
    } catch (error) {
      if (this._alive) this.setData({ testResult: error.message && !error.errMsg ? error.message : "测试结果暂无法确认，请查看最近提醒，避免重复测试。" });
    } finally {
      if (this._alive) {
        this.setData({ testBusy: false });
        await this.reload();
        await this.checkNotifications();
      }
    }
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
});
