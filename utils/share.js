const TYPES = Object.freeze({
  watchlist: { title: "关注清单", label: "MY LIST", description: "好友分享的关注清单" },
  holdings: { title: "持仓清单", label: "HOLDINGS", description: "好友分享的在持标的" },
  quote: { title: "数据详情", label: "DETAILS", description: "好友分享的数据" },
  reminders: { title: "条件提醒", label: "REMINDERS", description: "设好价格或涨跌幅条件，触发后可通过微信订阅消息接收提醒。" },
});
const MAX_ASSETS = 30;
const ASSET_ID = /^(?:gold-(?:au9999|xauusd)|(?:sh|sz|bj)\d{6}|hk\d{5}|us[A-Z][A-Z0-9]{0,19}(?:\.[A-Z])?)$/;
const validId = (id) => typeof id === "string" && id === id.trim() && ASSET_ID.test(id);
const validKind = (kind) => Object.prototype.hasOwnProperty.call(TYPES, kind);

function card(kind, ids = [], name = "", theme = "blackgold") {
  const list = [...new Set(ids.filter(validId))];
  const title = kind === "quote" && name ? name + " · 数据与提醒" :
    kind === "reminders" ? "条件提醒 · 达到设定条件时通知你" : TYPES[kind].title;
  return {
    title,
    imageUrl: "/assets/share/" + kind + (theme === "paper" ? "-paper" : "") + ".png",
    path: "/pages/share/share?kind=" + kind +
      (kind !== "reminders" && list.length ? "&ids=" + encodeURIComponent(list.join(",")) : ""),
  };
}

function parse(options = {}) {
  const { kind } = options;
  if (!validKind(kind)) return null;
  if (kind === "reminders") return { kind, ids: [] };
  // Entry parameters may already be decoded by the runtime.
  const value = options.ids == null ? "" : options.ids;
  if (typeof value !== "string" || value.length > 900) return null;
  const ids = value ? value.replace(/%2C/gi, ",").split(",") : [];
  if (ids.length > MAX_ASSETS || ids.some(id => !validId(id)) ||
      (kind === "quote" && ids.length !== 1)) return null;
  return { kind, ids: [...new Set(ids)] };
}

module.exports = { TYPES, card, parse };
