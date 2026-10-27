const TYPES = [
  { value: "priceAbove", label: "涨到价" },
  { value: "priceBelow", label: "跌到价" },
  { value: "dailyMove", label: "日涨跌幅" },
  { value: "rapidMove", label: "15 分钟急变" },
  { value: "scheduled", label: "定时播报" },
  { value: "close", label: "收盘提醒" },
];
function number(v, p = 2) {
  return v == null || !Number.isFinite(Number(v)) ? "--" : Number(v).toFixed(p);
}
function signed(v) {
  return v == null ? "--" : (v > 0 ? "+" : "") + number(v);
}
function time(ts, now = Date.now()) {
  if (!ts || !Number.isFinite(Number(ts))) return "行情时间待确认";
  const d = new Date(Number(ts) + 8 * 3600000);
  const today = new Date(Number(now) + 8 * 3600000);
  const pad = (n) => String(n).padStart(2, "0");
  const sameDay =
    d.getUTCFullYear() === today.getUTCFullYear() &&
    d.getUTCMonth() === today.getUTCMonth() &&
    d.getUTCDate() === today.getUTCDate();
  const date = sameDay
    ? ""
    : (d.getUTCFullYear() !== today.getUTCFullYear()
        ? d.getUTCFullYear() + "-"
        : "") +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate()) +
      " ";
  return (
    date + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + " 北京时间"
  );
}
function sourceName(source) {
  if (!source) return "行情源待确认";
  if (/^tencent/.test(source)) return "腾讯财经";
  if (/^eastmoney/.test(source)) return "东方财富";
  if (/^sina/.test(source)) return "新浪财经";
  if (/^sge/.test(source)) return "上海黄金交易所";
  return source;
}
function task(task) {
  const statuses = {
    pending: "待发送",
    processing: "发送中",
    sent: "已发送",
    cancelled: "已关闭",
    skipped: "已达上限",
    expired: "已过期",
    failed: "发送失败",
    "no-quota": "次数不足",
    "no-auth": "需重新授权",
    "pending-check": "待核查",
  };
  const reasons = {
    "settings-changed": "设置已变更，原提醒已取消",
    "stale-alert": "行情提醒已过时，不再补发",
    "dnd-past-expiry": "免打扰结束时提醒已过期，不再补发",
    dnd: "免打扰期间，时效内顺延发送",
    "daily-cap": "该类提醒已达今日发送上限",
    "quote-unavailable": "暂缺有效报价，等待后续扫描",
  };
  let reasonText = reasons[task.reason] || "";
  if (task.status === "no-quota")
    reasonText = "订阅授权次数不足，请增加授权次数";
  if (task.status === "no-auth") reasonText = "订阅授权不可用，请重新授权";
  if (task.status === "pending-check")
    reasonText = "发送结果待核查，请联系维护者";
  if (task.status === "expired" && !reasonText)
    reasonText = "行情提醒已过期，不再补发";
  if (task.status === "failed" && !reasonText)
    reasonText = "发送失败，请稍后刷新或联系维护者";
  const code = String(task.lastError || "");
  if (/^-?\d{1,10}$/.test(code))
    reasonText += (reasonText ? "；" : "") + "错误码 " + code;
  return {
    taskId: task.taskId,
    assetId: task.assetId,
    assetName: task.assetName || (task.type === "testNotification" ? "测试通知" : "行情提醒"),
    statusText: statuses[task.status] || "状态待确认",
    reasonText,
    timeText: time(task.sentAt || task.triggerTime || task.createdAt),
  };
}
function compact(value, unit) {
  if (value == null || !Number.isFinite(Number(value))) return "--";
  const n = Number(value);
  if (Math.abs(n) >= 1e8) return number(n / 1e8) + " 亿" + unit;
  if (Math.abs(n) >= 1e4) return number(n / 1e4) + " 万" + unit;
  return number(n) + " " + unit;
}
function volumeText(q, asset) {
  if (q.volumeUnit) return compact(q.volume, q.volumeUnit);
  // Provider stock adapters expose Tencent/Eastmoney lots and Sina shares.
  if (asset.kind !== "stock") return "--";
  if (/^sina/.test(q.source || "")) return compact(q.volume == null ? null : Number(q.volume) / 100, "手");
  if (/^(tencent|eastmoney)/.test(q.source || "")) return compact(q.volume, "手");
  return "--";
}
function quote(q = {}, asset = {}) {
  const fields = {};
  for (const key of ["price", "prevClose", "change", "changePct", "open", "high", "low", "volume", "amount"])
    fields[key] = q[key] == null || !Number.isFinite(Number(q[key])) ? null : Number(q[key]);
  q = { ...q, ...fields };
  const delayed = q.stale || q.status === "delayed" ||
    (Number(q.sourceTime) > 0 && Date.now() - Number(q.sourceTime) > 15 * 60000);
  return {
    ...q,
    volumeText: volumeText(q, asset),
    amountText: compact(q.amount, asset.currency === "USD" ? "美元" : "元"),
    priceText: number(q.price, asset.precision == null ? 2 : asset.precision),
    changeText: signed(q.change),
    pctText: q.changePct == null ? "--" : signed(q.changePct) + "%",
    cls: q.change > 0 ? "up" : q.change < 0 ? "down" : "flat",
    sourceText: sourceName(q.source),
    timeText: time(q.sourceTime),
    statusText:
      q.status === "unavailable"
        ? "暂不可用"
        : q.price == null
          ? "待获取"
          : q.cached
            ? "缓存行情 · 刷新失败"
            : !q.sourceTime
              ? "行情时间待确认"
              : delayed
                ? "延迟行情"
                : "行情更新",
  };
}
function summary(r, asset = {}) {
  const t = TYPES.find((t) => t.value === r.type);
  return (
    (t ? t.label : r.type) +
    (r.type === "scheduled"
      ? " " + r.time + (r.weekdaysOnly ? " · 仅周一至周五" : "")
      : r.type === "close"
        ? " · 有效收盘行情"
        : r.value != null
          ? " " +
            r.value +
            (["dailyMove", "rapidMove"].includes(r.type)
              ? "%"
              : " " + (asset.unit || ""))
          : "")
  );
}
module.exports = {
  TYPES,
  number,
  signed,
  time,
  sourceName,
  task,
  quote,
  summary,
};
