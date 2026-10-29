const market = require("../../utils/market-client");
const portfolio = require("../../utils/portfolio-client");
const theme = require("../../utils/theme");
const cache = require("../../utils/read-cache");
const fmt = require("../../utils/asset-format");
Page({
  data: {
    theme: theme.getTheme(),
    rows: [],
    limits: { watchlist: 5 },
    revision: 0,
    loading: true,
    errorText: "",
    manage: false,
    busy: false,
    draggingId: "",
    dragOffset: 0,
  },
  onLoad() {
    this._alive = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
  },
  async onShow() {
    this._alive = true;
    this._visible = true;
    this.setData({ theme: theme.getTheme() });
    theme.applyChrome(this.data.theme);
    this.stopPolling();
    if (this.data.loading && portfolio.getCached) {
      const saved = portfolio.getCached();
      if (saved) this.applyState(saved);
    }
    await this.reload();
    if (this._visible) this.timer = setInterval(() => this.loadQuotes(), 60000);
  },
  onHide() {
    this.cancelDrag();
    this._visible = false;
    this.stopPolling();
    this._request = (this._request || 0) + 1;
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
    if (this._drag || this.data.busy) return;
    const request = (this._request = (this._request || 0) + 1);
    try {
      const state = await portfolio.list();
      if (!this._alive || request !== this._request || this._drag || this.data.busy) return;
      this.applyState(state);
      await this.loadQuotes();
    } catch (e) {
      if (this._alive) this.setData({ loading: false });
    }
  },
  applyState(s) {
    this._state = s;
    const previousRows = new Map(this.data.rows.map((row) => [row.id, row]));
    this.setData({
      rows: s.items.map((a) => ({
        ...fmt.quote(previousRows.get(a.id) ||
          ((cache.forPlatform(wx).read("quote:" + a.id) || {}).quote || {}), a),
        ...a,
        note: (s.annotations && s.annotations[a.id] && s.annotations[a.id].note) || "",
        tags: (s.annotations && s.annotations[a.id] && s.annotations[a.id].tags) || [],
        activeCount: (s.rules || []).filter(
          (r) => r.assetId === a.id && r.enabled,
        ).length,
      })),
      limits: s.limits,
      revision: s.revision,
      errorText: "",
      loading: false,
    });
  },
  async loadQuotes() {
    if (!this._state || !this._state.items.length || this._drag || this.data.busy) return;
    const request = (this._quoteRequest = (this._quoteRequest || 0) + 1);
    const revision = this.data.revision;
    try {
      const result = await market.quotes(this._state.items.map((a) => a.id));
      if (
        !this._visible ||
        this._drag ||
        this.data.busy ||
        request !== this._quoteRequest ||
        revision !== this.data.revision
      )
        return;
      const quotes = result.quotes || [];
      this.setData({
        rows: this.data.rows.map((a) => {
          const quote = quotes.find((q) => q.assetId === a.id);
          // Keep the last successful quote until a usable replacement arrives.
          if (!quote || quote.price == null || !Number.isFinite(Number(quote.price)) || Number(quote.price) <= 0 || quote.status === "unavailable")
            return { ...a, ...fmt.quote({ ...a, stale: true, cached: true }, a) };
          return { ...a, ...fmt.quote(quote, a) };
        }),
        errorText: "",
      });
    } catch (e) {
      if (!this._visible || request !== this._quoteRequest || revision !== this.data.revision || this._drag || this.data.busy) return;
      this.setData({ rows: this.data.rows.map(a => ({ ...a, ...fmt.quote({ ...a, stale: true, cached: true }, a) })) });
    }
  },
  onPullDownRefresh() {
    return this.reload().finally(() => wx.stopPullDownRefresh());
  },
  openSearch() {
    wx.navigateTo({ url: "/pages/search/search" });
  },
  openDetail(e) {
    if (!this.data.manage)
      wx.navigateTo({
        url:
          "/pages/detail/detail?assetId=" +
          encodeURIComponent(e.currentTarget.dataset.id),
      });
  },
  toggleManage() {
    if (this.data.busy) return;
    this.cancelDrag();
    this.setData({ manage: !this.data.manage });
  },
  startDrag(e) {
    if (!this.data.manage || this.data.busy || this._drag || !e.touches.length) return;
    const id = e.currentTarget.dataset.id;
    const index = this.data.rows.findIndex(row => row.id === id);
    if (index < 0) return;
    const drag = this._drag = {
      id, index, startY: e.touches[0].clientY,
      original: this.data.rows.slice(), revision: this.data.revision,
    };
    this.setData({ draggingId: id, dragOffset: 0 });
    wx.createSelectorQuery().selectAll(".list-item").boundingClientRect(rects => {
      if (this._drag !== drag) return;
      if (!rects || rects.length !== drag.original.length || !rects[index].height) {
        this.cancelDrag();
        return;
      }
      drag.height = rects[index].height;
    }).exec();
  },
  dragMove(e) {
    const drag = this._drag;
    if (!drag || !drag.height || !e.touches.length) return;
    const delta = e.touches[0].clientY - drag.startY;
    const offset = Math.max(-drag.index * drag.height,
      Math.min((drag.original.length - 1 - drag.index) * drag.height, delta));
    const target = Math.max(0, Math.min(drag.original.length - 1,
      drag.index + Math.round(offset / drag.height)));
    const byId = new Map(this.data.rows.map(row => [row.id, row]));
    const rows = drag.original.map(row => byId.get(row.id) || row);
    const [row] = rows.splice(drag.index, 1);
    rows.splice(target, 0, row);
    this.setData({ rows, dragOffset: offset - (target - drag.index) * drag.height });
  },
  cancelDrag() {
    const drag = this._drag;
    this._drag = null;
    if (!drag) return;
    const byId = new Map(this.data.rows.map(row => [row.id, row]));
    this.setData({
      rows: drag.original.map(row => byId.get(row.id) || row),
      draggingId: "", dragOffset: 0,
    });
  },
  async endDrag() {
    const drag = this._drag;
    if (!drag) return;
    const ids = this.data.rows.map(row => row.id);
    this._drag = null;
    this.setData({ draggingId: "", dragOffset: 0 });
    if (ids.every((id, i) => id === drag.original[i].id)) return;
    this.setData({ busy: true });
    try {
      this.applyState(await portfolio.reorder(ids, drag.revision));
    } catch (e) {
      this.setData({ rows: drag.original, errorText: e.message });
    } finally {
      this.setData({ busy: false });
    }
  },
  remove(e) {
    if (this.data.busy || this._drag) return;
    const id = e.currentTarget.dataset.id;
    wx.showModal({
      title: "删除自选",
      content: "删除后，该标的的全部通知提醒也将一并删除，重新添加不会恢复。确定删除？",
      success: async (r) => {
        if (!r.confirm || this.data.busy) return;
        this.setData({ busy: true });
        try {
          this.applyState(await portfolio.remove(id));
        } catch (e) {
          this.setData({ errorText: e.message });
        } finally {
          this.setData({ busy: false });
        }
      },
    });
  },
});
