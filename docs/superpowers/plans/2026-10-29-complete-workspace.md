# Complete Personal Market Workspace Implementation Plan

> **For agentic workers:** Use subagent-driven-development with independent ownership and two-stage review. Preserve current branch changes and integrate in this session. User confirmed full personal market tool including manual holdings.

**Goal:** 完成图表、自选管理、市场发现、手工持仓和备份的完整个人看盘流程。

**Architecture:** 现有marketData/portfolio增加独立子模块；ledger为独立云函数与用户集合。前端沿用三Tab及主题，新增独立功能页。各云函数不跨目录import，外部请求在事务前完成。

**Tech Stack:** 微信原生JS/WXML/WXSS、云开发、Node test。

## 1. 图表增强

Files: `utils/chart-features.js`, `utils/candle-chart.js`, `pages/detail/detail.*`, chart and page tests.

- [x] 先测试日线周/月聚合跨年周、缺失量、BOLL20/2数学、量均线、缩放不改变指标种子、周期pending兼容。
- [x] 实现纯函数 `aggregateCandles`、`bollinger` 和视窗；Canvas接收完整历史和视窗，在可见部分绘制但全历史计算指标。
- [x] 集成日周月切换、BOLL/量MA开关、缩放/平移/回最新；保持原到价、MACD、均线和主题，页面状态无失效回写。
- [x] 子项目行为测试通过，独立审查。

## 2. 自选工作区与数据管理

Files: new `cloudfunctions/portfolio/workspace.js`, `utils/watchlist-view.js`, `utils/data-transfer.js`, `utils/display-preferences.js`, `pages/data/*`, `pages/index/*`, existing portfolio index/client.

- [x] 先测组名/成员/revision、删除组与删除自选差异、原子batchAdd、稳定排序与缺失值、CSV/JSON/代码解析及公式注入保护。
- [x] portfolio增加saveGroup/deleteGroup/batchAdd事务动作，原操作响应兼容返回groups；组内顺序与规则版本独立。
- [x] 首页提供组/类型/市场过滤、各组排序、字段与显示偏好、条件筛选；管理模式保留原拖拽。
- [x] 数据页解析→识别候选/歧义选择→预览→显式提交；导出版本化JSON/CSV，可选择文件导入与用户主动分享文件。
- [x] 手工持仓导入导出在独立持仓页通过ledger动作完成，用户数据不传第三方服务。

## 3. 独立持仓台账

Files: new `cloudfunctions/ledger/*`, `utils/ledger-client.js`, `pages/holdings/*`, ledger/math/page tests.

- [x] 先测交易重放：期初、买卖、费用、现金分红、入出金、超卖/负现金、当日盈亏示例、多币种、缺报价/昨收、重复提交、并发revision和跨用户隔离。
- [x] 独立ledger文档保存币种账户、交易及标的快照，金额上限和小数精度校验，不接受客户端身份或计算结果。不可修改行情主数据。
- [x] 手工记录并提供显式提交、流水修改/撤销后重算、现金/持仓/盈亏/仓位展示及排序；搜索加仓与自选关联不绕额度。
- [x] 版本化台账JSON导出及原子校验恢复，不自动导入提醒和权限。

## 4. 市场发现

Files: new `cloudfunctions/marketData/discovery.js`, `utils/discovery-client.js`, `pages/market/*` (and sector/constituent view if needed), tests and captured validation reports.

- [x] 按实测字段编写指数、板块、成分股和榜单解析测试，校验身份、缺失时间、空数据与缓存。
- [x] marketData handle增加独立action路由，不扩大股票canonical到指数代码；限制用户参数为白名单和已验证node，不允许任意URL。
- [x] 指数选择、行业/概念搜索、板块成分股、涨跌幅/成交额榜，整行详情和原地加入自选。
- [x] 有效资金数据独立展示来源和时间，失败有重试或旧缓存，不造实时数据；专业未核验字段不展示。

## 5. 集成与交付

Files: `app.json`, `pages/mine/*`, `app.wxss`, `cloudfunctions/initDb/index.js`, `docs/database-permissions.json`, `README.md`, delivery and research docs.

- [x] 增加新页面注册、首页与我的入口、全局低调样式，新增集合权限清单；三Tab保持兼容。
- [x] 需求符合性审查、质量审查并处理发现问题；运行全量 `node --test tests/*.test.js`、`git diff --check`、JS语法检查和真实公开数据只读验收。
- [x] 开发工具编译与主要页面流程检查；整理实现/排除清单、数据范围、云函数/权限部署清单、真机未验证项。
- [x] 本地分阶段提交，仅本分支；不推送、不部署生产。
