/**
 * 云端登记授权次数
 *
 * 入参：{ requestId: string, results: { [templateId]: 'accept'|'reject'|'ban' } }
 * - 用户身份一律从微信调用上下文获取，不信任前端传入的 openid
 * - 以 requestId 作为授权流水唯一键（_id），网络重试不会重复加次数
 * - 仅 'accept' 计入次数；剩余次数按「用户 + 模板」累计，上限 200
 * 登记次数属于业务账本，实际发送资格仍由微信侧判断。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const QUOTA_CAP = 200;
const VALID_RESULTS = ["accept", "reject", "ban"];

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) return { ok: false, err: "no-openid" };

  const requestId = event && event.requestId;
  const results = (event && event.results) || {};
  if (!requestId || typeof requestId !== "string" || requestId.length < 8 || requestId.length > 64) {
    return { ok: false, err: "bad-request-id" };
  }
  const entries = Object.keys(results)
    .filter((tid) => VALID_RESULTS.includes(results[tid]))
    .map((tid) => ({ templateId: tid, result: results[tid] }));
  if (!entries.length) return { ok: false, err: "bad-results" };

  // 幂等写入授权流水：_id = requestId，重复请求直接返回首次结果
  try {
    await db.collection("authLogs").add({
      data: {
        _id: requestId,
        openid: OPENID,
        results,
        createdAt: Date.now(),
        status: "registered"
      }
    });
  } catch (e) {
    const dup = e && (e.errCode === -502005 || /duplicate|exists/i.test(e.errMsg || ""));
    if (!dup) return { ok: false, err: "log-write-failed" };
    // 已登记过：读回现有次数，不重复累加
    return await snapshot(OPENID, true);
  }

  for (const { templateId, result } of entries) {
    if (result !== "accept") continue;
    await incRemaining(OPENID, templateId);
  }

  // 封顶：单模板最多 200
  for (const { templateId } of entries) {
    const doc = await db.collection("subscriptions").doc(OPENID + ":" + templateId).get().catch(() => null);
    const remain = doc && doc.data && doc.data.remaining;
    if (remain > QUOTA_CAP) {
      await db.collection("subscriptions").doc(OPENID + ":" + templateId).update({
        data: { remaining: QUOTA_CAP }
      });
    }
  }

  return await snapshot(OPENID, false);
};

/** 「用户+模板」计数 +1：update 优先，不存在则插入，处理并发重复插入 */
async function incRemaining(openid, templateId) {
  const ref = db.collection("subscriptions").doc(openid + ":" + templateId);
  const inc = () =>
    ref.update({ data: { remaining: _.inc(1), updatedAt: Date.now() } });
  try {
    const r = await inc();
    if (r.stats && r.stats.updated > 0) return;
    throw new Error("not-exists");
  } catch (e) {
    try {
      await ref.set({
        data: { openid, templateId, remaining: 1, updatedAt: Date.now() }
      });
    } catch (e2) {
      await inc();
    }
  }
}

async function snapshot(openid, replay) {
  const res = await db
    .collection("subscriptions")
    .where({ openid })
    .get();
  const remaining = {};
  for (const row of res.data) remaining[row.templateId] = row.remaining;
  return { ok: true, replay, remaining };
}
