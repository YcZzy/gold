const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const fmt = require("../../utils/asset-format");
Page({
  data: {
    theme: "paper",
    asset: null,
    rules: [],
    types: fmt.TYPES,
    editing: false,
    draft: {},
    pctOptions: [0.5, 1, 1.5, 2, 3, 5],
    pctIndex: 1,
    errorText: "",
    busy: false,
    following: false,
    loading: true,
  },
  onLoad(o) {
    this.assetId = o.assetId;
    this._alive = true;
  },
  onUnload() {
    this._alive = false;
  },
  async onShow() {
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    try {
      const results = await Promise.all([
        market.resolve(this.assetId),
        portfolio.list(),
      ]);
      if (!this._alive) return;
      const asset = results[0].asset || results[0];
      this.setData({
        asset,
        types: fmt.TYPES.filter(
          (t) =>
            t.value !== "close" ||
            asset.market === "SH" ||
            asset.market === "SZ" ||
            asset.id === "gold-au9999",
        ),
        loading: false,
      });
      this.applyState(results[1]);
    } catch (e) {
      if (this._alive) this.setData({ loading: false });
    }
  },
  applyState(s) {
    this._state = s;
    this.setData({
      rules: (s.rules || [])
        .filter((r) => r.assetId === this.assetId)
        .map((r) => ({ ...r, summary: fmt.summary(r, this.data.asset) })),
      following: s.items.some((a) => a.id === this.assetId),
      limits: s.limits,
      errorText: "",
    });
  },
  async follow() {
    if (this.data.busy) return;
    this.setData({ busy: true });
    try {
      this.applyState(await portfolio.add(this.assetId));
    } catch (e) {
      this.setData({ errorText: e.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  editRule(e) {
    const type = e.currentTarget.dataset.type;
    if (!this.data.types.some((t) => t.value === type)) return;
    const existing = this.data.rules.find((r) => r.type === type);
    const draft = existing
      ? { ...existing }
      : {
          assetId: this.assetId,
          type,
          enabled: true,
          ...(["priceAbove", "priceBelow", "dailyMove", "rapidMove"].includes(
            type,
          )
            ? { value: type.includes("Move") ? 1 : "" }
            : {}),
          ...(type === "scheduled"
            ? { time: "09:00", weekdaysOnly: this.data.asset.kind === "stock" }
            : {}),
        };
    const index = this.data.pctOptions.indexOf(Number(draft.value));
    this.setData({
      draft,
      editing: true,
      pctIndex: index < 0 ? 1 : index,
      errorText: "",
      editLabel: fmt.TYPES.find((t) => t.value === type).label,
    });
  },
  cancelEdit() {
    this.setData({ editing: false, errorText: "" });
  },
  onValue(e) {
    this.setData({ draft: { ...this.data.draft, value: e.detail.value } });
  },
  onPercent(e) {
    const index = Number(e.detail.value);
    this.setData({
      pctIndex: index,
      draft: { ...this.data.draft, value: this.data.pctOptions[index] },
    });
  },
  onTime(e) {
    this.setData({ draft: { ...this.data.draft, time: e.detail.value } });
  },
  onWeekdays(e) {
    this.setData({
      draft: { ...this.data.draft, weekdaysOnly: e.detail.value },
    });
  },
  onEnabled(e) {
    this.setData({ draft: { ...this.data.draft, enabled: e.detail.value } });
  },
  cleanRule(d) {
    const r = {
      assetId: this.assetId,
      type: d.type,
      enabled: d.enabled !== false,
    };
    if (d.id) r.id = d.id;
    if (d.version != null) r.version = d.version;
    if (["priceAbove", "priceBelow", "dailyMove", "rapidMove"].includes(d.type))
      r.value = Number(d.value);
    if (d.type === "scheduled") {
      r.time = d.time;
      r.weekdaysOnly = !!d.weekdaysOnly;
    }
    return r;
  },
  async saveRule() {
    if (this.data.busy) return;
    if (!this.data.following) {
      this.setData({ errorText: "请先加入自选，再保存提醒" });
      return;
    }
    const r = this.cleanRule(this.data.draft);
    if (
      "value" in r &&
      (!Number.isFinite(r.value) || r.value <= 0 || r.value > 1000000)
    ) {
      this.setData({ errorText: "请输入有效的正数" });
      return;
    }
    if (r.type === "scheduled" && !/^([01]\d|2[0-3]):[0-5]\d$/.test(r.time)) {
      this.setData({ errorText: "请选择有效时间" });
      return;
    }
    this.setData({ busy: true, errorText: "" });
    try {
      const s = await portfolio.saveRule(r);
      if (!this._alive) return;
      this.applyState(s);
      this.setData({ editing: false });
      wx.showToast({ title: "提醒已保存", icon: "success" });
    } catch (e) {
      if (this._alive) this.setData({ errorText: e.message });
    } finally {
      if (this._alive) this.setData({ busy: false });
    }
  },
  toggleRule(e) {
    const r = this.data.rules.find((r) => r.id === e.currentTarget.dataset.id);
    if (!r) return;
    const enabled = !!e.detail.value;
    const save = async () => {
      if (this.data.busy) return;
      this.setData({ busy: true, errorText: "" });
      try {
        this.applyState(
          await portfolio.saveRule(this.cleanRule({ ...r, enabled })),
        );
      } catch (e) {
        this.setData({
          errorText: e.message,
          rules: this.data.rules.map((x) => ({ ...x })),
        });
      } finally {
        this.setData({ busy: false });
      }
    };
    if (!enabled)
      wx.showModal({
        title: "暂停提醒",
        content: "暂停后，该规则不再触发推送。",
        success: (result) => {
          if (result.confirm) save();
          else this.setData({ rules: this.data.rules.map((x) => ({ ...x })) });
        },
      });
    else save();
  },
  deleteRule(e) {
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除提醒",
      content: "删除后需重新设置该规则。",
      success: async (r) => {
        if (!r.confirm || this.data.busy) return;
        this.setData({ busy: true });
        try {
          this.applyState(await portfolio.deleteRule(id));
        } catch (e) {
          this.setData({ errorText: e.message });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },
});
