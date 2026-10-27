/**
 * 查询提醒状态
 * 返回：各模板剩余次数、提醒偏好、最近发送任务
 * 用户身份取自微信调用上下文；用户不能查询他人数据。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const DEFAULT_PREFS = {
  dailyBrief: true,
  volatilityAu: false,
  volatilityXau: false,
  dndStart: "23:00",
  dndEnd: "07:30",
  theme: "paper",
  scheduledBrief: false,
  scheduledTime: "09:00",
  scheduledWeekdaysOnly: true,
  volatilityPct: 1.5,
  shortAu: false,
  shortXau: false,
  shortPct: 1
};

for (const key of ["targetAuLow", "targetAuHigh", "targetXauLow", "targetXauHigh"]) {
  DEFAULT_PREFS[key] = false;
  DEFAULT_PREFS[key + "Price"] = null;
  DEFAULT_PREFS[key + "RuleId"] = null;
}


// 仅缺少文档可以使用默认值；超时、权限等读取故障必须向上传递。
function missingPreference(error) {
  const message = String(error && (error.errMsg || error.message) || "");
  if (error && (error.code === "DOCUMENT_NOT_FOUND" ||
    error.errCode === "DATABASE_DOCUMENT_NOT_EXIST" ||
    /document(?: with _id [^\r\n]+?)? (?:does not exist|not exists?)\b/i.test(message))) return null;
  throw error;
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, err: "no-openid" };

  const [subs, prefsRes, tasksRes] = await Promise.all([
    db.collection("subscriptions").where({ openid: OPENID }).get(),
    db.collection("preferences").doc(OPENID).get().catch(missingPreference),
    db
      .collection("sendTasks")
      .where({ openid: OPENID })
      .orderBy("createdAt", "desc")
      .limit(10)
      .get()
  ]);

  const remaining = {};
  for (const row of subs.data) remaining[row.templateId] = row.remaining;

  return {
    ok: true,
    remaining,
    prefs: Object.assign({}, DEFAULT_PREFS, (prefsRes && prefsRes.data) || {}),
    recentTasks: (tasksRes.data || []).map((t) => ({
      taskId: t._id,
      type: t.type,
      status: t.status,
      triggerTime: t.triggerTime,
      createdAt: t.createdAt,
      reason: t.reason || "",
      lastError: t.lastError || "",
      ...(t.assetId ? { assetId: t.assetId, assetName: t.assetName || t.assetId } : {}),
      ...(t.schemaVersion != null ? { schemaVersion: t.schemaVersion } : {}),
      ...(t.sentAt != null ? { sentAt: t.sentAt } : {})
    }))
  };
};
