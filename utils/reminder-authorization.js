module.exports = function createAuthorization({ statusClient, templates, wx }) {
  const TPL_IDS = [templates.dailyBrief, templates.volatility];
  return {
    syncDnd(prefs) {
      if (!prefs || this.data.dndBusy) return;
      this.setData({ prefs: { ...this.data.prefs, dndStart: prefs.dndStart || this.data.prefs.dndStart, dndEnd: prefs.dndEnd || this.data.prefs.dndEnd } });
    },
    applyAuthStatus(r) {
      this.syncDnd(r.prefs);
      this.setData({ hasStatus: true, authError: "", quota: {
        brief: Number((r.remaining || {})[templates.dailyBrief] || 0),
        vol: Number((r.remaining || {})[templates.volatility] || 0),
      } });
    },
    async refreshAuth() {
      try {
        const r = await statusClient.getStatus(wx);
        if (!r || !r.ok) throw Error("授权状态获取失败");
        if (this._alive) this.applyAuthStatus(r);
      } catch (e) {
        if (this._alive) this.setData({ authError: "授权次数获取失败，请点击重试" });
      }
    },
    onAuthTap() {
      if (this.data.authBusy) return;
      this.setData({ authBusy: true, authError: "", authNote: "", errorText: "" });
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
                hasStatus: true,
                authNote: TPL_IDS.some(id => filtered[id] === "accept") ? "本次订阅已同意，剩余次数已更新，以页面显示为准。" : "本次未同意订阅，授权次数未增加。请再次点击增加授权次数，并选择允许。",
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
                  : "本次未同意，授权次数未增加",
                icon: "none",
              });
            }
          } catch (e) {
            if (this._alive) this.setData({ authError: e.message, errorText: e.message });
          } finally {
            if (this._alive) this.setData({ authBusy: false });
          }
        },
        fail: () => {
          if (this._alive)
            this.setData({
              authBusy: false,
              authError: "订阅授权未完成，请重试",
            });
        },
      });
    },
  };
};
