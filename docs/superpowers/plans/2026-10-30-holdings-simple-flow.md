# 持仓核心流程简化 Implementation Plan

**Goal:** 让查看与记账成为首页主任务，减少选择步骤和空状态噪声。

**Architecture:** 保留 ledger-client 与服务端核算。页面增加统一 view 切换与精简的交易/现金表单选项，移除独立类型选择页；展示数据由快照派生。

**Tech Stack:** 微信小程序 WXML/WXSS/JavaScript、node:test、微信开发者工具。

- [x] 更新 tests/holdings-page.test.js：直接记账/草稿继续、上下文现金、类型切换、单项展开、无现金市值标题、表单高级选项及卖出全部。
- [x] 确认新增回归测试失败。
- [x] pages/holdings/holdings.js：统一 view 状态、菜单路由、上下文表单、快照派生及草稿保护。
- [x] pages/holdings/holdings.wxml：精简首页、紧凑行、集中表单、记录与管理视图；高级字段按需显示。
- [x] pages/holdings/holdings.wxss：清理累积覆盖，重建一套紧凑双主题布局。
- [x] 完整 Node 测试、JS 检查、wcc/wcsc 编译与 git diff --check；模拟器只读与无提交交互验证。

验证结果：493/493 Node 测试通过，JavaScript 语法检查、微信 wcc/wcsc 原生编译和 git diff --check 均通过。微信开发者工具黑金主题实际检查了空仓首页、直接进入表单、买入类型切换、现金管理原生菜单、期初现金表单、交易记录与返回路径；调试器无新增 Errors。未向云端写入测试流水。非空持仓数据由页面回归测试覆盖，真机与浅色主题尚未视觉验收。

附带修复：普通刷新不清除未解决的草稿版本冲突；显式刷新草稿修订才允许重试；现金币种切换更新可用类型；编辑普通入金不允许再次设置期初现金。
