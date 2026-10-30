# 持仓页优化 Implementation Plan

**Goal:** 减少浏览信息密度、缩短查账路径并改善录入核对。

**Architecture:** 保留页面快照与服务端保存流程；页面负责筛选与折叠，新增纯函数模块负责表单校验及金额预览。

**Tech Stack:** 微信小程序 WXML / WXSS / JavaScript，node:test。

- [x] 为 tests/holdings-page.test.js 添加搜索、组合筛选、折叠状态、刷新并发及提交提示测试；新增 tests/holdings-form.test.js 测试六位小数、费用及现金方向。
- [x] 运行 `node --test tests/holdings-page.test.js tests/holdings-form.test.js`，确认新增行为失败。
- [x] 新建 utils/holdings-form.js，输出 errors、preview；仅预览使用数值，服务端仍为最终核算依据。
- [x] 修改 pages/holdings/holdings.js：筛选、折叠、刷新状态、就近校验及成功反馈；保留草稿与修订冲突机制。
- [x] 修改 pages/holdings/holdings.wxml 与 holdings.wxss：概览层级、精简卡片、展开详情、筛选栏、录入核对区域和空状态。
- [x] 运行新增测试、`node --test tests/*.test.js`、`git diff --check`，审查范围及隐私偏好。

验证记录：474/474 Node 测试通过；JavaScript 语法检查、git diff --check、微信 wcc/wcsc 原生编译通过。尚未进行模拟器或真机视觉验收。
