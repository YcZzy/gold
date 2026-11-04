const statusClient = require("../../utils/status-client");
const { templates } = require("../../utils/app-config");
const theme = require("../../utils/theme");
const portfolio = require("../../utils/portfolio-client");
const membership = require("../../utils/membership-client");
const fmt = require("../../utils/asset-format");
const cache = require("../../utils/read-cache");
function fmtMembershipExpiry(timestamp) {
  const date = new Date(timestamp + 8 * 3600000);
  return date.toISOString().slice(0, 16).replace("T", " ") + "（北京时间）";
}

Page({
  data: {
    theme: theme.getTheme(),
    hasStatus: false,
    hasPortfolio: false,
    prefs: { dndStart: "23:00", dndEnd: "07:30" },
    limits: { watchlist: 5, activeRules: 30, tier: "free" },
    quota: { brief: 0, vol: 0 },
    errorText: "",
    loading: true,
    checkBusy: false,
    testBusy: false,
    check: null,
    testResult: "",
    membershipBusy: false,
    membershipPending: false,
    membershipMessage: "",
    membershipExpiry: "",
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
    const membershipPending = !!membership.pendingOrder(wx);
    this.setData({ membershipPending });
    this.confirmMembership();
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
      await Promise.allSettled([
        portfolio.list().then(s => {
          if (!this._alive || !this._visible || request !== this._reloadRequest) return;
          if (s.offline && this.data.hasPortfolio) return;
          this.setData({
            hasPortfolio: true,
            limits: s.limits,
            membershipExpiry: s.limits.expiresAt ? fmtMembershipExpiry(s.limits.expiresAt) : "",
          });
        }),
        statusClient.getStatus(wx).then(r => {
          if (!r || !r.ok || !this._alive || !this._visible || request !== this._reloadRequest) return;
          this.applyStatus(r, { theme: theme.syncFromPrefs(r.prefs), errorText: "" });
        }),
      ]);
    } finally {
      if (this._alive && this._visible && request === this._reloadRequest)
        this.setData({ loading: false });
    }
  },
  async confirmMembership() {
    if (this.data.membershipBusy) return;
    this.setData({ membershipBusy: true });
    try {
      if (await membership.recoverOrder(wx)) await this.refreshMembershipOrder();
    } catch (_) {
      if (this._alive && membership.pendingOrder(wx)) this.setData({ membershipMessage: "订单确认中，请勿重复付款" });
    } finally {
      if (this._alive) this.setData({ membershipBusy: false, membershipPending: !!membership.pendingOrder(wx) });
    }
  },
  async buyMembership() {
    if (this.data.membershipBusy || membership.pendingOrder(wx)) return;
    this.setData({ membershipBusy: true, membershipMessage: "" });
    try {
      if (await membership.recoverOrder(wx) || await membership.purchase(wx)) {
        await this.refreshMembershipOrder();
      } else if (this._alive) this.setData({ membershipMessage: "已取消支付" });
    } catch (error) {
      if (membership.pendingOrder(wx)) await this.refreshMembershipOrder();
      else if (this._alive) this.setData({ membershipMessage: error.message || "暂时无法发起购买，请稍后再试" });
    } finally {
      if (this._alive) this.setData({ membershipBusy: false, membershipPending: !!membership.pendingOrder(wx) });
    }
  },
  async refreshMembershipOrder() {
    if (this._alive) this.setData({ membershipPending: true, membershipMessage: "正在确认订单，请勿重复付款" });
    const result = await membership.confirmUntilSettled(wx, { isActive: () => this._alive && this._visible });
    if (!result || !this._alive) return;
    if (result.status === "delivered") {
      require("../../utils/read-pool").forPlatform(wx).invalidate("portfolio:list");
      const expiresAt = Math.max(result.expiresAt || 0, this.data.limits.expiresAt || 0);
      this.setData({
        hasPortfolio: true,
        limits: { ...this.data.limits, watchlist: 30, tier: "vip", expiresAt },
        membershipExpiry: fmtMembershipExpiry(expiresAt),
        membershipMessage: "会员权益已生效",
      });
      await this.reload();
    } else {
      this.setData({ membershipMessage: result.status === "closed" ? "该订单已结束" : "订单确认中，请勿重复付款。可稍后查询订单。" });
    }
  },
  onThemeTap() {
    this.setData({
      theme: theme.setTheme(
        this.data.theme === "paper" ? "blackgold" : "paper",
      ),
    });
  },
  openWorkspace(e) {
    const target=e.currentTarget.dataset.target;
    if(['market','holdings','data'].includes(target))wx.navigateTo({url:'/pages/'+target+'/'+target});
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
          "no-quota": "异动授权次数不足，请到「提醒」页增加授权。",
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
    return Promise.all([this.reload(), this.confirmMembership()]).finally(() => wx.stopPullDownRefresh());
  },
});
