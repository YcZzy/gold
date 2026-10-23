/**
 * 保存提醒偏好
 *
 * 仅接受白名单字段：提醒开关（每日简报 / 沪金异动 / 伦敦金异动）、免打扰时段。
 * 额度（remaining）不在白名单内，用户无法通过本函数修改次数；
 * 接收者固定为调用者本人，无法指定任意接收者。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function sanitize(input) {
  const out = {};
  if (typeof input.dailyBrief === "boolean") out.dailyBrief = input.dailyBrief;
  if (typeof input.volatilityAu === "boolean") out.volatilityAu = input.volatilityAu;
  if (typeof input.volatilityXau === "boolean") out.volatilityXau = input.volatilityXau;
  if (typeof input.dndStart === "string" && TIME_RE.test(input.dndStart)) out.dndStart = input.dndStart;
  if (typeof input.dndEnd === "string" && TIME_RE.test(input.dndEnd)) out.dndEnd = input.dndEnd;
  return out;
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, err: "no-openid" };

  const patch = sanitize((event && event.prefs) || {});
  if (!Object.keys(patch).length) return { ok: false, err: "bad-prefs" };
  patch.updatedAt = Date.now();

  // 读旧值 → 合并 → 整篇写回（set 为覆盖语义）
  const prev = await db
    .collection("preferences")
    .doc(OPENID)
    .get()
    .catch(() => null);
  const merged = Object.assign({ openid: OPENID }, (prev && prev.data) || {}, patch);
  await db.collection("preferences").doc(OPENID).set({ data: merged });

  return { ok: true, prefs: merged };
};
