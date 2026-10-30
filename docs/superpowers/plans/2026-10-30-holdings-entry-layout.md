# 持仓页统一记账与布局 Implementation Plan

**Goal:** 消除两个入口的歧义，让记账与资产浏览各自清晰。

**Architecture:** 在 holdings 页面增加类型选择状态及仅内存保留的草稿返回路径，复用现有录入与保存实现；通过 WXML 条件分区隔离编辑与浏览。

**Tech Stack:** 微信小程序 JavaScript / WXML / WXSS，node:test。

- [x] tests/holdings-page.test.js：验证单入口不默认创建流水、类型选择、返回与恢复草稿、覆盖取消及直接买卖。
- [x] 运行 `node --test tests/holdings-page.test.js` 确认新增测试失败。
- [x] pages/holdings/holdings.js：增加 chooser 状态、类型说明、继续草稿与覆盖确认，保存成功清理草稿。
- [x] pages/holdings/holdings.wxml：单入口、分组类型选择、编辑隔离、资产先于浏览导航、次要备份入口。
- [x] pages/holdings/holdings.wxss：顶部操作、类型选择卡片、浏览导航、列表工具栏与紧凑模式布局。
- [x] 运行 `node --test tests/*.test.js`、JS 语法检查、微信 wcc/wcsc 编译及 `git diff --check`，检查本轮改动范围。

用户追加的展示要求已纳入：首屏仅突出资产与持仓核心信息，数量成本/备注/来源与次要操作收进详情，精简重复说明和流水修订信息。验证结果：484/484 Node 测试通过，JavaScript 语法检查、微信 wcc/wcsc 编译及 git diff --check 均通过。未进行模拟器或真机视觉验收。
