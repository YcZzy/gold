/**
 * 一次性初始化云数据库集合（幂等，可重复执行，不会破坏已有数据）
 *
 * 幂等创建集合（与云函数代码保持一致）：
 *   - subscriptions  订阅余量账本（_id = `${openid}:${templateId}`，代码显式指定）
 *   - preferences    提醒偏好（_id = openid，代码显式指定）
 *   - authLogs       授权流水（requestId 幂等去重）
 *   - sendTasks      发送任务（status+triggerTime 查询）
 *   - quoteSnapshots 短时波动的有界滚动行情快照
 *   - portfolios 用户自选和按标的提醒；entitlements 服务端会员权益
 *   - instruments / quoteCache / chartCache / searchCache 行情目录与缓存
 *   - sendBudgets 按用户每日原子发送预算
 *
 * 使用方式：
 *   1. 开发者工具右键本函数「上传并部署：云端安装依赖」
 *   2. 云开发控制台 → 云函数 → initDb → 云端测试（事件留空 {}）→ 运行
 *   3. 返回 created/exists 均为正常；用完可删除本函数（不影响业务）
 *
 * 注意：
 *   - 已存在的集合会被跳过（createCollection 对已存在集合会报错，这里识别为 exists）
 *   - 集合创建后必须在控制台改为「所有用户不可读写」，只允许云函数访问。
 *     客户端只调用云函数；仅创建者权限不足以保护会员权益、次数和自选上限。
 *   - 索引（sendTasks 的 status+triggerTime 等）SDK 不支持创建，量大后在控制台「索引管理」手动加
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = [
  "subscriptions", "preferences", "authLogs", "sendTasks", "quoteSnapshots",
  "portfolios", "entitlements", "instruments", "quoteCache", "chartCache", "searchCache", "sendBudgets"
];

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
      "请到控制台将所有集合权限设为「所有用户不可读写」，仅云函数访问；" +
      "用户量过千后到「索引管理」给 sendTasks 加 (status,triggerTime) 与 (openid,status,sentAt) 组合索引。"
  };
};
