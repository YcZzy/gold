const theme = require("../utils/theme");

const TABS = [
  { pagePath: "pages/index/index", text: "自选", icon: "watchlist" },
  { pagePath: "pages/reminders/reminders", text: "提醒", icon: "reminders" },
  { pagePath: "pages/mine/mine", text: "我的", icon: "mine" },
];

// Each tab page owns a component instance. Carry only the last confirmed route
// across instances so the destination's capsule can move from the previous tab.
let lastSelected = null;

Component({
  data: {
    theme: theme.getTheme(),
    selected: 0,
    indicatorIndex: 0,
    indicatorFrom: 0,
    indicatorDuration: 250,
    indicatorMotion: false,
    tabs: TABS,
  },
  lifetimes: {
    attached() {
      this._detached = false;
      this.syncFromPage();
    },
    detached() {
      this._detached = true;
      this._syncVersion = (this._syncVersion || 0) + 1;
    },
  },
  pageLifetimes: {
    show() { this.syncFromPage(); },
    hide() {
      this._syncVersion = (this._syncVersion || 0) + 1;
      this.setData({ indicatorMotion: false, indicatorIndex: this.data.selected });
    },
  },
  methods: {
    syncFromPage(themeName) {
      if (this._detached) return;
      const pages = getCurrentPages();
      const route = pages.length ? pages[pages.length - 1].route : "";
      const selected = TABS.findIndex(tab => tab.pagePath === route);
      if (selected < 0) return;
      const nextTheme = theme.isValid(themeName) ? themeName : theme.getTheme();
      if (this._route === route && lastSelected === selected) {
        if (this.data.theme !== nextTheme) this.setData({ theme: nextTheme });
        return;
      }
      this._route = route;
      const version = this._syncVersion = (this._syncVersion || 0) + 1;
      const from = lastSelected == null ? selected : lastSelected;
      lastSelected = selected;
      const indicatorDuration = Math.abs(selected - from) === 2 ? 320 : 250;
      this.setData({
        theme: nextTheme, selected, indicatorIndex: from, indicatorFrom: from,
        indicatorDuration, indicatorMotion: false,
      }, () => {
        if (from === selected) return;
        wx.nextTick(() => {
          if (!this._detached && version === this._syncVersion)
            this.setData({ indicatorIndex: selected, indicatorMotion: true });
        });
      });
    },
    switchTab(event) {
      const raw = event.currentTarget.dataset.index;
      if (raw === "" || raw == null) return;
      const index = Number(raw);
      if (!Number.isInteger(index) || !TABS[index] || this._switching) return;
      const pages = getCurrentPages();
      const route = pages.length ? pages[pages.length - 1].route : "";
      if (route === TABS[index].pagePath) return;
      this._switching = true;
      wx.switchTab({
        url: "/" + TABS[index].pagePath,
        // The destination's page/attachment lifecycle confirms the route.
        // Updating this hidden source here would consume its transition.
        fail: () => {
          this.syncFromPage();
          wx.showToast({ title: "页面切换失败，请重试", icon: "none" });
        },
        complete: () => { this._switching = false; },
      });
    },
  },
});
