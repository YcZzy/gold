/**
 * 主题管理（paper 纸感 / blackgold 黑金）
 * - 本地缓存即时生效：刷新、下次启动直接用上次主题
 * - 云端持久化：savePrefs 写入 preferences.theme，跨设备同步
 * - applyChrome 显式同步原生顶部导航和自定义底栏；窗口背景由 page-meta 声明
 * - chartColors：K 线 canvas 配色随主题变化（见 utils/candle-chart.js）
 */
const KEY = "gold-theme";
const THEMES = ["paper", "blackgold"];
// 本设备已确定的主题是唯一显示依据；存储失败时仍保留本次会话的选择。
let currentTheme = null;
let savingTheme = false;
let queuedTheme = null;

// 图表 canvas 调色板（paper 用 candle-chart.js 内置默认色）
const CHART_PALETTES = {
  paper: null,
  blackgold: {
    grid: "rgba(217,180,91,0.14)",
    axisText: "#9a8f6e",
    cross: "rgba(242,230,201,0.5)",
    last: "#d9b45b",
    baseline: "rgba(217,180,91,0.45)",
    up: "#ff7a6b",
    down: "#4dbe84",
    upFill: "rgba(255,122,107,0.85)",
    downFill: "rgba(77,190,132,0.85)",
    upArea: "rgba(255,122,107,0.12)",
    downArea: "rgba(77,190,132,0.12)",
    volUp: "rgba(255,122,107,0.4)",
    volDown: "rgba(77,190,132,0.4)",
    ma5: "#6ea3e8",
    ma10: "#e8b05c"
  }
};

// 主题切换按钮图标（SVG 转 base64 data URI，小程序 image 需 base64 才能渲染）：
// 纸感下显示月亮（去黑金），黑金下显示太阳（回纸感）
const ICON_MOON =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDliNDViIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTIxIDEyLjc5QTkgOSAwIDEgMSAxMS4yMSAzIDcgNyAwIDAgMCAyMSAxMi43OXoiLz48L3N2Zz4=";
const ICON_SUN =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDliNDViIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCI+PGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iNCIvPjxwYXRoIGQ9Ik0xMiAydjJNMTIgMjB2Mk00LjkzIDQuOTNsMS40MSAxLjQxTTE3LjY2IDE3LjY2bDEuNDEgMS40MU0yIDEyaDJNMjAgMTJoMk00LjkzIDE5LjA3bDEuNDEtMS40MU0xNy42NiA2LjM0bDEuNDEtMS40MSIvPjwvc3ZnPg==";

// 提醒按钮铃铛（颜色随按钮底色：纸感=墨底白铃，黑金=金底黑铃）
const ICON_BELL_WHITE =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZmZmZmZmIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDhBNiA2IDAgMCAwIDYgOGMwIDctMyA5LTMgOWgxOHMtMy0yLTMtOSIvPjxwYXRoIGQ9Ik0xMy43MyAyMWEyIDIgMCAwIDEtMy40NiAwIi8+PC9zdmc+";
const ICON_BELL_DARK =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjMTQxMjBiIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDhBNiA2IDAgMCAwIDYgOGMwIDctMyA5LTMgOWgxOHMtMy0yLTMtOSIvPjxwYXRoIGQ9Ik0xMy43MyAyMWEyIDIgMCAwIDEtMy40NiAwIi8+PC9zdmc+";

// 提醒引导条铃铛（金色描边，两种主题通用）
const ICON_BELL_GOLD =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDliNDViIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBhdGggZD0iTTE4IDhBNiA2IDAgMCAwIDYgOGMwIDctMyA5LTMgOWgxOHMtMy0yLTMtOSIvPjxwYXRoIGQ9Ik0xMy43MyAyMWEyIDIgMCAwIDEtMy40NiAwIi8+PC9zdmc+";

// 刷新图标（金色描边，两种主题通用）
const ICON_REFRESH =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZDliNDViIiBzdHJva2Utd2lkdGg9IjIiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCI+PHBvbHlsaW5lIHBvaW50cz0iMjMgNCAyMyAxMCAxNyAxMCIvPjxwYXRoIGQ9Ik0yMC40OSAxNWE5IDkgMCAxIDEtMi4xMi05LjM2TDIzIDEwIi8+PC9zdmc+";

/** 提醒主按钮的铃铛图标（随主题换色） */
function bellIcon(theme) {
  return theme === "blackgold" ? ICON_BELL_DARK : ICON_BELL_WHITE;
}

/** 主题对应的切换图标（点击后进入另一主题） */
function themeIcon(theme) {
  return theme === "blackgold" ? ICON_SUN : ICON_MOON;
}

function isValid(t) {
  return THEMES.indexOf(t) >= 0;
}

function getTheme() {
  if (isValid(currentTheme)) return currentTheme;
  try {
    const t = wx.getStorageSync(KEY);
    if (isValid(t)) return (currentTheme = t);
  } catch (e) {
    /* 缓存读取失败用默认 */
  }
  return "paper";
}

function cacheTheme(theme) {
  currentTheme = theme;
  try {
    wx.setStorageSync(KEY, theme);
  } catch (e) {
    /* ignore */
  }
}

function applyChrome(theme) {
  if (!isValid(theme)) theme = "paper";
  // The native navigation bar lives outside the page's rendered content.
  // Use one explicit update path on theme changes and page show; page-meta
  // only owns window backgrounds so it cannot overwrite this navigation color.
  if (typeof wx.setNavigationBarColor === "function") {
    wx.setNavigationBarColor({
      frontColor: theme === "blackgold" ? "#ffffff" : "#000000",
      backgroundColor: theme === "blackgold" ? "#14120b" : "#FAF8F3",
      animation: { duration: 0, timingFunc: "linear" },
      fail: error => console.warn("导航栏主题同步失败", error),
    });
  }
  const pages = typeof getCurrentPages === "function" ? getCurrentPages() : [];
  const page = pages[pages.length - 1];
  const bar = page && typeof page.getTabBar === "function" && page.getTabBar();
  if (bar && typeof bar.syncFromPage === "function") bar.syncFromPage(theme);
  // An unattached custom bar synchronizes in attached(); never style a native
  // tab bar as a fallback while waiting for this component to become ready.
}

function chartColors(theme) {
  return CHART_PALETTES[theme] || {};
}

// 串行保存并合并等待中的切换，避免较早的写入后完成而覆盖最后一次选择。
async function saveTheme() {
  if (savingTheme || !queuedTheme || !wx.cloud || !wx.cloud.callFunction) return;
  const theme = queuedTheme;
  queuedTheme = null;
  savingTheme = true;
  try {
    await wx.cloud.callFunction({ name: "savePrefs", data: { prefs: { theme } } });
  } catch (e) {
    // 云端失败不回滚本设备主题；下次主动切换仍会保存最新选择。
  } finally {
    savingTheme = false;
    if (queuedTheme) saveTheme();
  }
}

/** 切换主题：会话状态 / 本地缓存 / 顶部导航和自定义底栏即时生效，异步串行保存云端。 */
function setTheme(theme) {
  if (!isValid(theme)) theme = "paper";
  cacheTheme(theme);
  applyChrome(theme);
  queuedTheme = theme;
  saveTheme();
  return theme;
}

/** 仅在本设备没有有效主题时从云端初始化，旧响应和离线缓存不能覆盖本地选择。 */
function syncFromPrefs(prefs) {
  const local = getTheme();
  if (isValid(currentTheme)) return local;
  if (prefs && isValid(prefs.theme)) {
    cacheTheme(prefs.theme);
    applyChrome(prefs.theme);
    return prefs.theme;
  }
  return local;
}

module.exports = { getTheme, setTheme, applyChrome, chartColors, syncFromPrefs, themeIcon, bellIcon, ICON_REFRESH, ICON_BELL_GOLD, isValid };
