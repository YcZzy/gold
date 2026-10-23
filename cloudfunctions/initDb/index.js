/**
 * 一次性初始化云数据库集合（幂等，可重复执行，不会破坏已有数据）
 *
 * 创建 4 个集合（与云函数代码保持一致）：
 *   - subscriptions  订阅余量账本（_id = `${openid}:${templateId}`，代码显式指定）
 *   - preferences    提醒偏好（_id = openid，代码显式指定）
 *   - authLogs       授权流水（requestId 幂等去重）
 *   - sendTasks      发送任务（status+triggerTime 查询）
 *
 * 使用方式：
 *   1. 开发者工具右键本函数「上传并部署：云端安装依赖」
 *   2. 云开发控制台 → 云函数 → initDb → 云端测试（事件留空 {}）→ 运行
 *   3. 返回 created/exists 均为正常；用完可删除本函数（不影响业务）
 *
 * 注意：
 *   - 已存在的集合会被跳过（createCollection 对已存在集合会报错，这里识别为 exists）
 *   - 云函数建的集合权限默认「仅创建者可读写」，建议到控制台确认一遍
 *   - 索引（sendTasks 的 status+triggerTime 等）SDK 不支持创建，量大后在控制台「索引管理」手动加
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = ["subscriptions", "preferences", "authLogs", "sendTasks"];

function classifyError(err) {
  const msg = String((err && (err.errMsg || err.message)) || err || "");
  if (/exists|已存在|already/i.test(msg)) return "exists";
  return "error: " + msg;
}

exports.main = async () => {
  const results = {};
  let ok = true;

  for (const name of COLLECTIONS) {
    try {
      await db.createCollection(name);
      results[name] = "created";
    } catch (e) {
      const status = classifyError(e);
      results[name] = status;
      if (status.startsWith("error")) ok = false;
    }
  }

  // 自检：逐个集合做一次轻量读，确认全部可访问
  const verified = {};
  for (const name of COLLECTIONS) {
    try {
      await db.collection(name).limit(1).get();
      verified[name] = true;
    } catch (e) {
      verified[name] = false;
      ok = false;
    }
  }

  return {
    ok,
    results,
    verified,
    hint:
      "created=新建 exists=已存在跳过 verified=读自检通过。" +
      "请到控制台确认 4 个集合权限为「仅创建者可读写」；" +
      "用户量过千后到「索引管理」给 sendTasks 加 (status,triggerTime) 与 (openid,status,sentAt) 组合索引。"
  };
};
