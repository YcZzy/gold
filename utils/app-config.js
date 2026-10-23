/**
 * 全局配置（上线前替换 TODO 项）
 *
 * 上线清单：
 * 1. cloudEnv：微信开发者工具 → 云开发 → 设置 → 环境 ID
 * 2. 模板 ID：小程序后台 → 订阅消息 → 选用模板（类目：财经/行情提醒），把模板 ID 填到下方
 *    两个模板：每日行情简报 / 波动异动提醒（沪金与伦敦金共用异动模板）
 * 3. 云函数逐个上传并部署（含 sendTask 的定时触发器）
 * 4. 真机验证：授权弹窗、离线接收、扣次数、断网重试不重复扣
 */
module.exports = {
  // TODO: 替换为你的云开发环境 ID
  cloudEnv: "cloud1-3gbiogrx67d1e65c",

  // 订阅消息模板 ID（公共模板库选用，key 与 sendTask 的 buildData 对应）
  templates: {
    dailyBrief: "Wn6LX6JivcT9MkSoM81zR2uvcSFOEx3IuFLT5QXEVhw", // 每日数据更新通知（产品名称/今日价格/昨日涨跌/统计日期）
    volatility: "mQZ8fr72Xbf5nMlEjhP1ie9gl-2ndoeZa8_8upWsDYs" // 涨幅变动通知（沪金/伦敦金异动共用）
  },

  // 业务上限（文档约定）
  quotaCapPerTemplate: 200, // 单用户单模板累计上限

  // 提醒策略默认值（可在「提醒」页调整部分项）
  strategy: {
    briefTime: "15:40", // 每日简报（沪金收盘后）
    briefDays: [1, 2, 3, 4, 5], // 周一至周五
    maxPerDay: 3, // 每日推送总上限：简报 1 + 沪金异动 1 + 伦敦金异动 1
    maxBriefPerDay: 1,
    maxVolPerDay: 1, // 每个品种各 1 条/日
    volatilityPct: 1.5, // 异动阈值：较昨收涨跌幅 %
    dndStart: "23:00", // 免打扰开始
    dndEnd: "07:30" // 免打扰结束
  }
};
