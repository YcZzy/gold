# Market polish implementation plan

**Goal:** 落实已批准的市场页紧凑布局、清晰榜单与查询状态隔离。
**Architecture:** 保留微信小程序 Page 与现有 discovery/portfolio 客户端。WXML 管理结构，WXSS 复用主题变量，JS 在请求发起时同步展示类型并按查询键隔离快照。
**Tech Stack:** WXML, WXSS, JavaScript, node:test。

- [x] 在 tests/market-page.test.js 添加延迟分类切换、失败查询隔离、搜索提交/清空、第十页、排名回归测试；执行 node --test tests/market-page.test.js 确认新断言失败。
- [x] 在 pages/market/market.js 将标题、isSector、isFlow 在请求前计算；以 section/selectedSector/page/sort/submittedKeyword/sectorSort 生成查询键，变化时清空旧快照。增加 searchKeyword、clearSearch，提交时 trim 搜索内容；响应页数用于 20 条分页排名与 hasMore 上限。
- [x] 重组 pages/market/market.wxml：横滑指数、指数编辑面板、四类切换、集中筛选、静态加载占位、分列行情和自选、来源和说明。
- [x] 重写 pages/market/market.wxss 为可读分段样式，复用全局双主题；处理长名称、窄屏、静默模式、按钮焦点和安全区。
- [x] 执行 node --test tests/market-page.test.js 与 node --test tests/*.test.js；运行 node --check pages/market/market.js、git diff --check 并检查模板事件与标签闭合。记录微信开发者工具未运行的限制。

验证结果：462/462 Node 测试通过；页面 JavaScript 语法检查、git diff --check、微信 wcc/wcsc 编译通过。未运行微信模拟器或真机视觉验收。市场页为普通导航页，使用自身 safe-area 留白，不套用 tabBar 页面额外高度。空结果的后续页仍显示分页，允许返回上一页。
