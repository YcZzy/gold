/** 保存调用者的提醒偏好；额度、接收者、规则标识均不接受客户端修改。 */
const cloud = require("wx-server-sdk");
const crypto = require("crypto");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const PERCENTAGES = [0.5, 1, 1.5, 2, 3, 5];
const TARGETS = ["targetAuLow", "targetAuHigh", "targetXauLow", "targetXauHigh"];
const DEFAULT_PREFS = {
  dailyBrief: true, volatilityAu: false, volatilityXau: false,
  dndStart: "23:00", dndEnd: "07:30", theme: "paper",
  scheduledBrief: false, scheduledTime: "09:00", scheduledWeekdaysOnly: true,
  volatilityPct: 1.5, shortAu: false, shortXau: false, shortPct: 1
};
for (const key of TARGETS) {
  DEFAULT_PREFS[key] = false;
  DEFAULT_PREFS[key + "Price"] = null;
  DEFAULT_PREFS[key + "RuleId"] = null;
}

function validPrice(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 &&
    value <= 1000000 && /^\d+(?:\.\d{1,2})?$/.test(String(value));
}

function sanitize(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("提醒设置格式不正确");
  }
  const validators = {
    dndStart: v => typeof v === "string" && TIME_RE.test(v),
    dndEnd: v => typeof v === "string" && TIME_RE.test(v),
    scheduledTime: v => typeof v === "string" && TIME_RE.test(v),
    theme: v => v === "paper" || v === "blackgold",
    volatilityPct: v => PERCENTAGES.includes(v),
    shortPct: v => PERCENTAGES.includes(v)
  };
  for (const key of ["dailyBrief", "volatilityAu", "volatilityXau", "scheduledBrief",
    "scheduledWeekdaysOnly", "shortAu", "shortXau", ...TARGETS]) {
    validators[key] = v => typeof v === "boolean";
  }
  for (const key of TARGETS) validators[key + "Price"] = v => v === null || validPrice(v);
  const out = {};
  for (const key of Object.keys(validators)) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (!validators[key](input[key])) throw new Error("提醒设置无效，请检查时间、开关、涨跌幅和目标价格（最多两位小数）");
    out[key] = input[key];
  }
  return out;
}


// 仅缺少文档可以使用默认值；超时、权限等读取故障必须向上传递。
function missingPreference(error) {
  const message = String(error && (error.errMsg || error.message) || "");
  if (error && (error.code === "DOCUMENT_NOT_FOUND" ||
    error.errCode === "DATABASE_DOCUMENT_NOT_EXIST" ||
    /document(?: with _id [^\r\n]+?)? (?:does not exist|not exists?)\b/i.test(message))) return null;
  throw error;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, err: "no-openid" };

  let patch;
  try {
    patch = sanitize(event && event.prefs);
  } catch (error) {
    return { ok: false, err: "bad-prefs", hint: error.message };
  }
  if (!Object.keys(patch).length) return { ok: false, err: "bad-prefs", hint: "请选择要保存的提醒设置" };
  const doc = db.collection("preferences").doc(OPENID);
  const prev = await doc.get().catch(missingPreference);
  const old = Object.assign({}, DEFAULT_PREFS, (prev && prev.data) || {});
  // 数据库文档带有只读 _id，不能包含在 set / update 数据中。
  delete old._id;
  const merged = Object.assign({}, old, patch, { openid: OPENID });
  for (const key of TARGETS) {
    if (merged[key] && !validPrice(merged[key + "Price"])) {
      return { ok: false, err: "bad-prefs", hint: "开启目标价提醒前，请填写有效的目标价格（最多两位小数）" };
    }
    const priceKey = key + "Price";
    if ((!old[key] && merged[key]) || old[priceKey] !== merged[priceKey]) {
      patch[key + "RuleId"] = crypto.randomBytes(16).toString("hex");
    }
  }
  patch.updatedAt = Date.now();
  Object.assign(merged, patch);
  if (prev && prev.data) {
    // 只更新本次修改，避免主题等无关保存覆盖任务引擎刚关闭的一次性规则。
    await doc.update({ data: patch });
    // 引擎可能在读取旧值后消费了一次性规则，返回落库后的当前状态。
    const saved = await doc.get();
    const current = Object.assign({}, DEFAULT_PREFS, saved.data, { openid: OPENID });
    delete current._id;
    return { ok: true, prefs: current };
  } else {
    await doc.set({ data: merged });
  }
  return { ok: true, prefs: merged };
};
