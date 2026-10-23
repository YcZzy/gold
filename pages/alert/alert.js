const { cloudEnv, templates, quotaCapPerTemplate } = require("../../utils/app-config.js");

const TPL_IDS = [templates.dailyBrief, templates.volatility];

const TYPE_TEXT = {
  dailyBrief: "每日简报",
  volAu: "沪金异动",
  volXau: "伦敦金异动"
};
const STATUS_TEXT = {
  pending: "待发送",
  sent: "已发送",
  cancelled: "已关闭",
  skipped: "已达上限",
  expired: "已过期",
  failed: "发送失败",
  "no-quota": "次数不足",
  "no-auth": "需重新授权",
  "pending-check": "待核查"
};

function uuid() {
  let s = "";
  for (let i = 0; i < 32; i++) s += Math.floor(Math.random() * 16).toString(16);
  return "req-" + Date.now().toString(36) + "-" + s;
}

Page({
  data: {
    quota: { brief: 0, vol: 0 },
    prefs: {
      dailyBrief: true,
      volatilityAu: false,
      volatilityXau: false,
      dndStart: "23:00",
      dndEnd: "07:30"
    },
    recent: []
  },

  onLoad() {
    if (!wx.cloud) {
      wx.showToast({ title: "基础库过低", icon: "none" });
      return;
    }
    if (cloudEnv === "YOUR_ENV_ID") {
      wx.showToast({ title: "请先配置云环境", icon: "none" });
    }
    this.refreshStatus();
  },

  async refreshStatus() {
    try {
      const res = await wx.cloud.callFunction({ name: "getStatus" });
      const r = res.result || {};
      if (!r.ok) throw new Error(r.err || "status-failed");
      this.applyStatus(r);
    } catch (e) {
      wx.showToast({ title: "状态获取失败", icon: "none" });
    }
  },

  applyStatus(r) {
    const remain = r.remaining || {};
    this.setData({
      quota: {
        brief: remain[templates.dailyBrief] || 0,
        vol: remain[templates.volatility] || 0
      },
      prefs: Object.assign({}, this.data.prefs, r.prefs || {}),
      recent: (r.recentTasks || []).map((t) => ({
        taskId: t.taskId,
        typeText: TYPE_TEXT[t.type] || t.type,
        status: t.status,
        statusText: STATUS_TEXT[t.status] || t.status,
        timeText: this.fmtTs(t.triggerTime || t.createdAt)
      }))
    });
  },

  fmtTs(ts) {
    if (!ts) return "--";
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
  },

  /** 逐次授权：每点一次弹一次框，同意的模板 +1 次 */
  onAuthTap() {
    if (TPL_IDS.some((id) => !id || id.indexOf("TODO") === 0)) {
      wx.showModal({
        title: "未配置模板",
        content: "请先在 utils/app-config.js 填入订阅消息模板 ID，并在小程序后台选用对应模板。",
        showCancel: false
      });
      return;
    }
    wx.requestSubscribeMessage({
      tmplIds: TPL_IDS,
      success: async (r) => {
        const results = {};
        TPL_IDS.forEach((id) => {
          if (r[id]) results[id] = r[id]; // accept / reject / ban
        });
        try {
          const res = await wx.cloud.callFunction({
            name: "registerAuth",
            data: { requestId: uuid(), results }
          });
          const out = res.result || {};
          if (!out.ok) throw new Error(out.err || "register-failed");
          const remain = out.remaining || {};
          this.setData({
            quota: {
              brief: remain[templates.dailyBrief] || 0,
              vol: remain[templates.volatility] || 0
            }
          });
          const added = Object.values(results).filter((v) => v === "accept").length;
          wx.showToast({ title: added ? "已增加 " + added + " 次" : "未授权", icon: "none" });
        } catch (e) {
          wx.showToast({ title: "登记失败，请重试", icon: "none" });
        }
      },
      fail: () => {
        wx.showToast({ title: "授权弹窗失败", icon: "none" });
      }
    });
  },

  onSwitch(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ ["prefs." + key]: !!e.detail.value });
    this.autoSave();
  },

  onDndStart(e) {
    this.setData({ "prefs.dndStart": e.detail.value });
    this.autoSave();
  },

  onDndEnd(e) {
    this.setData({ "prefs.dndEnd": e.detail.value });
    this.autoSave();
  },

  /** 改动即保存：防抖 400ms，连续切换合并为一次请求 */
  autoSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this.doSave(), 400);
  },

  async doSave() {
    const prefs = Object.assign({}, this.data.prefs);
    try {
      const res = await wx.cloud.callFunction({
        name: "savePrefs",
        data: { prefs }
      });
      const out = res.result || {};
      if (!out.ok) throw new Error(out.err || "save-failed");
      this.setData({ prefs: Object.assign({}, this.data.prefs, out.prefs || {}) });
      wx.showToast({ title: "已保存", icon: "success", duration: 700 });
    } catch (e) {
      wx.showToast({ title: "保存失败，请重试", icon: "none" });
    }
  }
});
