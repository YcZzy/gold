const statusClient = require("../../utils/status-client");
const { cloudEnv, templates, quotaCapPerTemplate } = require("../../utils/app-config.js");
const themeUtil = require("../../utils/theme.js");

const TPL_IDS = [templates.dailyBrief, templates.volatility];

const TYPE_TEXT = {
  dailyBrief: "每日简报",
  volAu: "沪金异动",
  volXau: "伦敦金异动",
  scheduledBrief: "定时播报",
  shortAu: "沪金短时急变",
  shortXau: "伦敦金短时急变",
  targetAuLow: "沪金跌到价",
  targetAuHigh: "沪金涨到价",
  targetXauLow: "伦敦金跌到价",
  targetXauHigh: "伦敦金涨到价"
};
const STATUS_TEXT = {
  pending: "待发送",
  processing: "发送中",
  sent: "已发送",
  cancelled: "已关闭",
  skipped: "已达上限",
  expired: "已过期",
  failed: "发送失败",
  "no-quota": "次数不足",
  "no-auth": "需重新授权",
  "pending-check": "待核查"
};

const REASON_TEXT = {
  "settings-changed": "设置已变更，原提醒已取消",
  "stale-alert": "行情预警已过时，不再补发",
  "dnd-past-expiry": "免打扰结束时提醒已过期，不再补发",
  dnd: "免打扰期间，时效内顺延发送",
  "daily-cap": "该类提醒已达今日发送上限",
  "quote-unavailable": "暂缺有效报价，等待后续扫描"
};
function taskReason(task) {
  let text = REASON_TEXT[task.reason] || "";
  if (task.status === "no-quota") text = "推送次数不足，请点击上方按钮增加授权次数";
  if (task.status === "no-auth") text = "订阅授权不可用，请点击上方按钮重新授权";
  if (task.status === "pending-check") text = "发送结果待核查，请联系维护者检查云函数日志";
  if (!text && task.status === "failed") text = "发送失败，请稍后刷新或联系维护者";
  // Only a standalone platform error number is safe and useful to display.
  const code = String(task.lastError || "");
  if (/^-?\d{1,10}$/.test(code)) text += (text ? "；" : "") + "错误码 " + code;
  return text;
}

const TARGET_KEYS = ["targetAuLow", "targetAuHigh", "targetXauLow", "targetXauHigh"];
const SWITCH_KEYS = ["dailyBrief", "scheduledBrief", "scheduledWeekdaysOnly", "volatilityAu", "volatilityXau", "shortAu", "shortXau"].concat(TARGET_KEYS);
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
function validPrice(value) {
  return /^\d+(\.\d{1,2})?$/.test(String(value)) && Number(value) > 0 && Number(value) <= 1000000;
}

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
      scheduledBrief: false,
      scheduledTime: "09:00",
      scheduledWeekdaysOnly: true,
      volatilityPct: 1.5,
      shortAu: false,
      shortXau: false,
      shortPct: 1,
      targetAuLow: false,
      targetAuLowPrice: null,
      targetAuHigh: false,
      targetAuHighPrice: null,
      targetXauLow: false,
      targetXauLowPrice: null,
      targetXauHigh: false,
      targetXauHighPrice: null,
      volatilityAu: false,
      volatilityXau: false,
      dndStart: "23:00",
      dndEnd: "07:30"
    },
    pctOptions: [0.5, 1, 1.5, 2, 3, 5],
    volatilityPctIndex: 2,
    shortPctIndex: 1,
    quotaCap: quotaCapPerTemplate,
    targetRules: [
      { key: "targetAuLow", label: "沪金跌到价", unit: "元/克" },
      { key: "targetAuHigh", label: "沪金涨到价", unit: "元/克" },
      { key: "targetXauLow", label: "伦敦金跌到价", unit: "美元/盎司" },
      { key: "targetXauHigh", label: "伦敦金涨到价", unit: "美元/盎司" }
    ],
    priceDrafts: { targetAuLow: "", targetAuHigh: "", targetXauLow: "", targetXauHigh: "" },
    priceErrors: {},
    saveError: "",
    recent: [],
    theme: themeUtil.getTheme()
  },

  onLoad() {
    this.setData({ theme: themeUtil.getTheme() });
    themeUtil.applyChrome(this.data.theme);
    if (!wx.cloud) {
      console.warn("基础库过低");
      return;
    }
    if (cloudEnv === "YOUR_ENV_ID") {
      console.warn("请先配置云环境");
    }
  },

  onShow() {
    this._visible = true;
    this.setData({ theme: themeUtil.getTheme() });
    themeUtil.applyChrome(this.data.theme);
    if (wx.cloud) return this.refreshStatus();
  },

  onHide() {
    this._visible = false;
    this._statusRequest = (this._statusRequest || 0) + 1;
  },

  onUnload() {
    this._unloaded = true;
    this.onHide();
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = null;
    this.doSave();
  },

  async refreshStatus() {
    const version = this._editVersion || 0;
    const request = this._statusRequest = (this._statusRequest || 0) + 1;
    try {
      const r = await statusClient.getStatus(wx);
      if (!r.ok) throw new Error(r.err || "status-failed");
      if (!this._unloaded && this._visible !== false && request === this._statusRequest)
        this.applyStatus(r, version);
    } catch (e) {
      // Keep the last successful status.
    }
  },

  applyStatus(r, version) {
    this.setData({ hasStatus: true });
    // 云端主题回填（跨设备同步），本页只跟随不提供切换入口
    const t = themeUtil.syncFromPrefs(r.prefs);
    if (t !== this.data.theme) this.setData({ theme: t });
    this.mergePrefs(r.prefs, version);
    const remain = r.remaining || {};
    this.setData({
      quota: {
        brief: remain[templates.dailyBrief] || 0,
        vol: remain[templates.volatility] || 0
      },

      recent: (r.recentTasks || []).map((t) => ({
        taskId: t.taskId,
        typeText: TYPE_TEXT[t.type] || t.type,
        status: t.status,
        statusText: STATUS_TEXT[t.status] || t.status,
        reasonText: taskReason(t),
        timeText: this.fmtTs((t.status === "sent" && t.sentAt) || t.triggerTime || t.createdAt)
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
          statusClient.updateStatus(wx, out);
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
          console.warn("授权登记未完成", e);
        }
      },
      fail: () => {
        console.warn("订阅授权未完成");
      }
    });
  },

  mergePrefs(prefs, version) {
    const patch = {};
    Object.keys(prefs || {}).forEach((key) => {
      if (Object.prototype.hasOwnProperty.call(this._dirty || {}, key) ||
          Object.prototype.hasOwnProperty.call(this._inFlight || {}, key) ||
          (version !== undefined && ((this._fieldVersions || {})[key] || 0) > version)) return;
      patch["prefs." + key] = prefs[key];
      const rule = TARGET_KEYS.find((k) => k + "Price" === key);
      if (rule && !(this._editingPrices || {})[rule] && !this.data.priceErrors[rule]) patch["priceDrafts." + rule] = prefs[key] == null ? "" : String(prefs[key]);
    });
    this.setData(patch);
    this.setData({
      volatilityPctIndex: this.data.pctOptions.indexOf(this.data.prefs.volatilityPct),
      shortPctIndex: this.data.pctOptions.indexOf(this.data.prefs.shortPct)
    });
  },

  queuePatch(patch) {
    this._dirty = Object.assign(this._dirty || {}, patch);
    this._fieldVersions = this._fieldVersions || {};
    this._editVersion = (this._editVersion || 0) + 1;
    const display = {};
    Object.keys(patch).forEach((key) => {
      display["prefs." + key] = patch[key];
      this._fieldVersions[key] = this._editVersion;
    });
    this.setData(display);
    this.autoSave();
  },

  onSwitch(e) {
    const key = e.currentTarget.dataset.key;
    if (SWITCH_KEYS.indexOf(key) < 0) return;
    const value = !!e.detail.value;
    if (value && TARGET_KEYS.indexOf(key) >= 0 && !validPrice(this.data.priceDrafts[key])) {
      this.setData({ ["prefs." + key]: false, ["priceErrors." + key]: "请先输入有效目标价" });
      wx.showToast({ title: "请先输入有效目标价", icon: "none" });
      return;
    }
    if (value && TARGET_KEYS.indexOf(key) >= 0) {
      if (this._editingPrices) delete this._editingPrices[key];
      this.queuePatch({ [key + "Price"]: Number(this.data.priceDrafts[key]), [key]: true });
      return;
    }
    this.queuePatch({ [key]: value });
  },

  onTargetDraft(e) {
    const key = e.currentTarget.dataset.key;
    if (TARGET_KEYS.indexOf(key) < 0) return;
    const value = String(e.detail.value).trim();
    this._editingPrices = this._editingPrices || {};
    this._editingPrices[key] = true;
    this.setData({ ["priceDrafts." + key]: value, ["priceErrors." + key]: value && !validPrice(value) ? "当前输入未保存；仍按上次有效价格与开关执行。请输入大于 0、不超过 1000000 的价格，最多两位小数" : "" });
  },

  onTargetPrice(e) {
    const key = e.currentTarget.dataset.key;
    if (TARGET_KEYS.indexOf(key) < 0) return;
    const value = String(e.detail.value).trim();
    const valid = validPrice(value);
    this.onTargetDraft(e);
    if (valid || !value) delete this._editingPrices[key];
    if (valid && Number(value) !== this.data.prefs[key + "Price"]) this.queuePatch({ [key + "Price"]: Number(value) });
    else if (!value) this.queuePatch({ [key + "Price"]: null, [key]: false });
  },

  onPctChange(e) {
    const key = e.currentTarget.dataset.key;
    const index = Number(e.detail.value);
    if (["volatilityPct", "shortPct"].indexOf(key) < 0 || !Number.isInteger(index) || !this.data.pctOptions[index]) return;
    this.setData({ [key + "Index"]: index });
    this.queuePatch({ [key]: this.data.pctOptions[index] });
  },

  onScheduledTime(e) { this.setTime("scheduledTime", e.detail.value); },
  onDndStart(e) { this.setTime("dndStart", e.detail.value); },
  onDndEnd(e) { this.setTime("dndEnd", e.detail.value); },
  setTime(key, value) {
    if (TIME_RE.test(value)) this.queuePatch({ [key]: value });
  },

  /** 只发送改动字段，避免把已被服务端关闭的一次性提醒重新开启。 */
  autoSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => { this._saveTimer = null; this.doSave(); }, 400);
  },

  async doSave() {
    if (this._saving) return;
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = null;
    if (!Object.keys(this._dirty || {}).length) return;
    const prefs = this._dirty;
    const version = this._editVersion || 0;
    this._dirty = {};
    this._inFlight = prefs;
    this._saving = true;
    let saved = false;
    try {
      const res = await wx.cloud.callFunction({ name: "savePrefs", data: { prefs } });
      const out = res.result || {};
      if (!out.ok) throw new Error(out.hint || "保存失败，请重试");
      statusClient.updateStatus(wx, { ...out, prefs: { ...prefs, ...out.prefs } });
      // A status request issued before this successful write may contain older preferences.
      this._statusRequest = (this._statusRequest || 0) + 1;
      this._inFlight = null;
      this.mergePrefs(out.prefs, version);
      this.setData({ saveError: "" });
      saved = true;
      if (!this._unloaded) wx.showToast({ title: "已保存", icon: "success", duration: 700 });
    } catch (e) {
      this._dirty = Object.assign({}, prefs, this._dirty);
      const message = e.message && e.message !== "save-failed" ? e.message : "保存失败，请重试";
      this.setData({ saveError: message });
      console.warn("偏好设置未保存", e);
    } finally {
      this._saving = false;
      this._inFlight = null;
    }
    if (saved && Object.keys(this._dirty).length) this.doSave();
  }
});
