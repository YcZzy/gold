# 自选首页与详情页 Implementation Plan

**Goal:** 改善两个页面的信息层级、窄屏布局和操作反馈。

**Architecture:** 保留微信原生 WXML / WXSS / Page 架构及行情逻辑。新增样式分别限定在 `.home-page`、`.detail-page`，不改供其他页面导入的基础样式。交互派生状态集中在首页 `updateView`，详情使用独立布尔展开状态。

**Tech Stack:** 微信小程序、Node.js 内置测试、微信开发者工具 CLI。

## 1. 行为回归

- [ ] 在 `tests/workspace-page.test.js` 先添加筛选数量（含 0）、负数输入中间态、上下限错误、空分组返回全部的测试。
- [ ] 在 `tests/detail-extras.test.js` 添加浏览工具/图表说明独立展开、并发刷新防重测试。
- [ ] 执行 `node --test tests/workspace-page.test.js tests/detail-extras.test.js`，确认新增行为测试失败。

## 2. 首页

- [ ] 修改 `pages/index/index.js` 的 `updateView`，派生 `filterCount`、`filterError`、当前分组名称；`setCondition` 接受负数输入中间态。
- [ ] 重组 `pages/index/index.wxml` 的快捷入口、分组滚动、筛选、列表表头与空状态；所有原事件继续绑定。
- [ ] 仅重写 `pages/index/index.wxss` 中 Home-only 注释之后的样式，保留共享区和等高管理行。
- [ ] 执行首页相关测试。

## 3. 详情

- [ ] 为 `pages/detail/detail.js` 添加 `chartToolsOpen`、`chartInfoOpen` 和对应切换方法。
- [ ] 重组 `pages/detail/detail.wxml`：报价先于提醒；图表先于折叠浏览与指标；来源、数据风险提示保留；补充无报价状态。
- [ ] 整理 `pages/detail/detail.wxss`，仅使用页面作用域，统一控件尺寸、卡片及表单。
- [ ] 执行详情与首页行为测试及完整 `node --test tests/*.test.js`。

## 4. 验收

- [ ] 使用开发者工具 CLI 编译；如自动化服务可用，验证本地页面状态与截图。
- [ ] 检查纸感/黑金、320px 窄屏、空列表、长名称、筛选、管理模式和历史浏览。
- [ ] `git diff --check`，审阅差异与记录实际验证限制。
