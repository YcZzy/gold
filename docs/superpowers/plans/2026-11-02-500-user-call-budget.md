# 500 用户云调用预算实施计划

本轮在当前工作区执行，保留已有未提交改动，不自动提交或部署。用户已确认分钟提醒和每月 200 单位。

**目标：** 500 用户各 5 标的，按新版本正常负载控制在每月约 20 万次。

**架构：** 复用公共快照和单次批量扫描，扩容 2500 标的；前后端同步缩减月分配上限。

**技术：** 微信云开发、CommonJS、node:test。

- [x] 修改 `tests/batch-quotes.test.js` 和 `tests/asset-engine.test.js`：2500 不同标的、跨 500 用户完整覆盖、共享去重、休市跳过、无授权预热、并发最多 10 批及部分失败；运行并确认旧实现因 500 容量上限失败。
- [x] 修改 `cloudfunctions/marketData/batch-quotes.js` 和 `cloudfunctions/sendTask/asset-tasks.js`：容量提升至 2500，500 以内维持 3 批并发，以上最多 10 批；重跑相关回归。
- [x] 修改 `tests/call-budget-service.test.js` 和 `tests/cloud-call-budget.test.js`：200 单位、跨设备并发、旧 800 分配返回耗尽、不重置当月账本；运行并确认旧 800 实现失败。
- [x] 修改 `cloudfunctions/callBudget/index.js` 与 `utils/cloud-call-budget.js`：同步 200 单位，历史超额视为耗尽；重跑额度与客户端回归。
- [x] 更新 README 与预算部署文档，写明 189,280 模型、10,720 余量、部署顺序和切换期限制。执行 `node --test --test-timeout=30000 tests/*.test.js`（592/592通过）、相关 JS 语法检查和 `git diff --check`。
