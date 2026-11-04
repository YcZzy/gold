const TYPES = Object.freeze({
  watchlist: { title: "自选清单", label: "WATCHLIST", description: "好友分享的全部自选" },
  holdings: { title: "持仓清单", label: "HOLDINGS", description: "好友分享的在持标的" },
  quote: { title: "标的行情", label: "MARKET QUOTE", description: "好友分享的行情" },
  reminders: { title: "行情提醒", label: "PRICE ALERTS", description: "设好价格或涨跌幅条件，触发后可通过微信订阅消息接收提醒。" },
});
const MAX_ASSETS = 30;
const ASSET_ID = /^(?:gold-(?:au9999|xauusd)|(?:sh|sz|bj)\d{6}|hk\d{5}|us[A-Z][A-Z0-9]{0,19}(?:\.[A-Z])?)$/;
const validId = (id) => typeof id === "string" && id === id.trim() && ASSET_ID.test(id);
const validKind = (kind) => Object.prototype.hasOwnProperty.call(TYPES, kind);

function card(kind, ids = [], name = "", theme = "blackgold") {
  const list = [...new Set(ids.filter(validId))];
  const title = kind === "quote" && name ? name + " · 行情与提醒" :
    kind === "reminders" ? "行情提醒 · 价格触发时通知你" : TYPES[kind].title;
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
