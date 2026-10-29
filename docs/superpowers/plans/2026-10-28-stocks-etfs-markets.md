# 股票与 ETF 多市场扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 验证公开数据路由后，为沪深、北交所、香港、美国股票与 ETF 接通搜索、自选、报价、图表和提醒。

**Architecture:** 延续 Node.js 微信云函数；资产识别、供应商路由和市场时间独立成模块。统一 Unix 时间、经过验证的元数据和按标的返回的错误；前端沿用现有页面。

**Tech Stack:** CommonJS、Node.js 内置测试、HTTPS、微信小程序及云开发。

## Task 0：真实接口验证（实施前置条件）

Files: `docs/market-validation-2026-10-28.json`、`tests/fixtures/markets/`。

- [x] 使用只读网络请求验证股票、ETF、港股多币种和带点美股代码；保存真实样本、来源 URL、验证时间、数据时间和失败原因。
- [x] 验证所有图表周期，筛选返回证券身份准确、不复权且具有真实日期的数据路由。请求限制按供应商返回处理。
- [x] 获取完整北交所证券目录来源、港美股类型及币种依据，确认目录可更新，不能用示例股票替代完整市场目录。
- [x] 核对交易所官方 2026/2027 日历、半日市、收市竞价、盘后固定价格交易规则，保存来源和有效年份。
- [x] 对目录／报价／图表／日历的缺口先解决再进入 Task 1。网络偶发失败记录并验证备用源，不更改 TLS 校验。

## Task 1：资产及行情服务

Files: `cloudfunctions/marketData/instruments.js`、`market-time.js`、`international.js`、`index.js`、北交所目录文件、`tests/multi-market-data.test.js`。

- [x] 先写失败测试并执行 `node --test tests/multi-market-data.test.js`，覆盖真实样本分类、币种、报价身份、纽约夏令时、ETF 三位小数、成交额／量单位和错误数据源降级。
- [x] 资产契约保留原有字段，增加 `kind: stock|etf|gold`、`timezone`、`exchange`、`providers`、`supportsClose`；新增市场 BJ/HK/US，ID 样式 `bj920185`、`hk00700`、`usAAPL`，带点股份类别保留。
- [x] 解析器拒绝任意 URL 和脚本型代码；仅信任目录及供应商已验证的资产元数据。证券 ID 与腾讯交易所后缀分离。
- [x] 接入已通过 Task 0 的搜索、报价、分时及日 K 路由；股票与 ETF 都参与批量报价。空主源仍尝试备用源，按标的报告失败，缓存保留原数据时间。
- [x] 为 `searchCache`／`chartCache` 增加结构版本，旧沪深资产元数据重新合并验证。保留黄金旧路径。
- [x] 执行新行情测试与 `node --test tests/market-data.test.js tests/read-cache.test.js`，修复具体回归。

## Task 2：自选服务与价格规则

Files: `cloudfunctions/portfolio/index.js`、其部署目录内证券校验模块、`tests/portfolio-markets.test.js`。

- [x] 测试港美股、北交所、ETF 添加／移除／排序及独立提醒，并观察原实现拒绝新增市场的失败。
- [x] 服务端保留证券元数据的明确字段白名单，验证 ID、市场、类型、币种、单位、精度及供应商映射；从服务端行情服务解析，拒绝客户端伪造元数据。
- [x] 目标价精度按 `asset.precision` 校验，例如 510300 接受 4.152，拒绝四位小数；原有沪深股票与黄金保持两位规则。
- [x] 收盘能力从验证元数据取得；前后端一致拒绝不支持收盘的标的。
- [x] 执行 `node --test tests/portfolio*.test.js`。

## Task 3：市场时间、日历及提醒

Files: `cloudfunctions/sendTask/market-calendar.js`、日历数据文件、`asset-tasks.js`、`tests/market-calendar.test.js`、`tests/asset-engine.test.js`。

- [x] 写失败用例：纽约跨北京时间午夜、夏令时、2026-11-27 提前收盘、港股半日市、休市、迟到／盘后报价不触发。
- [x] 市场日历契约 `session(asset, epoch) -> {date, phase, closeTime, known}`；以 IANA 时区换算，未知年份不发收盘简报；发送额度和定时播报继续按北京时间。
- [x] 日内波动按市场交易日去重，15 分钟基准不跨交易日／午休／来源；目标价、波动仅用常规盘有效新鲜报价。
- [x] 收盘规则等待最终常规收盘数据，半日市／提前收盘使用对应时点，消息价格携带正确币种和精度。
- [x] 执行 `node --test tests/market-calendar.test.js tests/asset-engine.test.js tests/reminder-rules.test.js`。

## Task 4：前端、集成及交付

Files: `utils/asset-format.js`、`pages/search/search.wxml`、`pages/asset-alert/asset-alert.js`、`pages/mine/mine.wxml`、`tests/asset-pages.test.js`、`scripts/smoke-market.js`、`README.md`。

- [x] 新增功能性用例验证 ETF／港美股显示单位、三位小数、北京时间及收盘规则可用性，沿用已有页面测试装载器。
- [x] 调整搜索提示、证券类型／市场文案、成交额币种和成交量单位；继续使用现有主题与导航，不覆盖工作区原有 UI 修改。
- [x] 将真实接口验收扩为各市场矩阵，执行搜索、resolve、混合报价、所有周期及主源故障路径；报告每项实际成功／失败，不将缓存充作独立来源成功。
- [x] 执行 `node --test tests/*.test.js` 和真实接口验收；逐文件 `node --check`，`git diff --check`，复核云函数打包目录内依赖完整。
- [x] 对照设计逐项进行规格审查，再做代码质量审查；修复发现的问题并重跑相关验证。
- [x] 更新 README 的实际覆盖、延迟限制、目录／日历更新和需要重新部署的云函数。交付时明确本地验证与云端真机验收边界。

## 执行约束

用户要求先验证相关功能、接口和数据，Task 0 的证据必须先完成，不能提前修改生产代码。当前基线 `node --test tests/*.test.js`：260 通过、0 失败。工作区已有未提交的导航、主题和页面修改，实施在当前功能分支保留这些内容，按新增功能的文件／差异审查，不全量暂存。

## 实际完成记录（2026-10-29）

329 项自动测试、105 项跨市场真实接口、18 项兼容链路验收通过；规格与代码质量复审均 PASS。今日官方目录为 BJ354、HK3208。交付记录见 `docs/market-delivery-2026-10-29.md`，机器可读摘要见 `docs/market-acceptance-2026-10-29.json`。云端部署和真实微信送达未作为本地成功声称。工作区原有主题／导航修改保留，代码留在当前功能分支供审阅。
