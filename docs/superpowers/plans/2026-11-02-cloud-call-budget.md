# Cloud Call Budget Implementation Plan

> Execute inline in the current workspace, preserving all existing uncommitted work.

**Goal:** 在100人各5股票场景压缩云调用，保留分钟级提醒。
**Architecture:** 后台单次批量调用；公共行情投影直读；客户端统一月预算与成功读TTL；服务端报告实际嵌套次数。
**Tech Stack:** 微信云开发、CommonJS、node:test。

- [x] 新增tests/cloud-call-budget.test.js：验证计数持久化/月切换/失败计费/并发/拒绝写入/TTL与写失效。先运行失败，再实现utils/cloud-call-budget.js并在app.js初始化。
- [x] 新增tests/public-quotes.test.js：直读命中零函数、过期回源、错误回退、身份及时间校验。实现utils/public-quotes.js并接入utils/market-client.js。
- [x] 批量入口测试先失败，再实现marketData/batch-quotes.js，每批30、并发3、总量500。scan改为每轮一次，更新500标的回归；非提醒自选也更新公共行情。
- [x] marketData写公共投影，initDb添加集合，权限仅该集合允许读、禁止写。portfolio/ledger响应附实际调用数，使前台预算按实际消耗。
- [x] node --test --test-timeout=30000 tests/*.test.js，语法检查与git diff --check；记录部署顺序、31天预算、清缓存/多设备与生产统计限制。

最终补充：callBudget事务跨设备分配月额度；scan-lease按分钟去重。独立复查发现的持久化失败和部分余额可用性问题均已补回归并修复。最终测试记录见交付文档。
