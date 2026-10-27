# 多标的行情实施计划

**目标：** 开发黄金 + 沪深 A 股自选列表、搜索联想、独立行情详情、按标的提醒及多源数据兜底，保留原授权与主题。

**架构：** marketData 云函数统一公开数据适配、目录与行情缓存；portfolio 云函数使用用户级事务管理自选及内嵌规则；sendTask 按规则扫描并发送。前端通过轻量 client 调用云函数。原黄金提醒迁移到新规则后使用版本标记停用旧扫描，旧数据不清空。

**技术：** 微信小程序 JS/WXML/WXSS、wx-server-sdk、Node 内置测试；沿用当前 canvas 图表与主题。

## 固定接口约定

### 标的

`asset = {id,name,code,market,kind,currency,unit,secid,quoteCode,precision}`。

- 黄金 ID：`gold-au9999`（沪金 / SGE / CNY / 元/克 / 118.AU9999）、`gold-xauusd`（伦敦金 / GLOBAL / USD / 美元/盎司 / 122.XAU）。
- 股票 ID：`sh600519`、`sz000001`，市场 SH/SZ，kind=stock，currency=CNY，unit=元/股。
- 内部 ID 与供应商映射由服务端解析和校验，不接受任意 URL。

### marketData

- `search {keyword}` → `{ok,assets:[asset],source,stale?}`。
- `resolve {assetId}` → `{ok,asset}`。
- `quote {assetId}` → `{ok,asset,quote}`。
- `quotes {assetIds}` → `{ok,assets:[asset],quotes:[quote],errors:[{assetId,hint}]}`，最多 30。
- `chart {assetId,period}` → `{ok,asset,chart}`；period 为 intraday/1mo/3mo/1y/5y。
- `quote={assetId,price,prevClose,change,changePct,open,high,low,volume,amount,source,sourceTime,fetchedAt,stale,status}`；无值为 null，时间毫秒。status 为 fresh/delayed/unavailable，stale 必须真实反映来源时间。
- `chart={mode:'intraday'|'candle',points?:[{time,price,avg,v}],candles?:[{time,o,h,l,c,v}],prevClose,source,sourceTime,fetchedAt,stale}`。

### portfolio

`portfolios` 文档 ID=OPENID，保存 `{openid,items:[assetId],rules:[rule],revision,migrationVersion:1,updatedAt}`。规则内嵌保证自选额度、规则和取消关注暂停可在一个用户级事务完成。

`rule={id,assetId,type,enabled,value?,time?,weekdaysOnly?,version,createdAt,updatedAt}`。

类型固定：priceAbove / priceBelow / dailyMove / rapidMove / scheduled / close。id 服务端生成或使用用户+资产+类型唯一键；version 服务端随机版本，修改条件和重新开启时轮换。

- `list {}` → `{ok,items:[asset],rules:[rule],limits:{watchlist:5,activeRules:30,tier:'free',expiresAt:null},revision}`。
- `add {assetId}`、`remove {assetId}`、`reorder {assetIds,revision}` → 同 list。remove 同事务暂停对应规则；reorder 要求当前完整集合且版本匹配。
- `saveRule {assetId,type,enabled,value?,time?,weekdaysOnly?}` → 同 list。
- `deleteRule {ruleId}` → 同 list。
- 所有失败 `{ok:false,err,hint}`。limit/rule-limit/revision-conflict 均提供可读中文 hint。
- 初次 list 幂等迁移两个黄金自选和旧提醒：dailyBrief→Au close；scheduledBrief→Au scheduled；volatilityAu/Xau→dailyMove；shortAu/Xau→rapidMove；四类 target→priceBelow/priceAbove。保留开关、条件、一次性规则版本；已有主题/DND/授权账本保持。
- 事务提交时设置 preferences.multiAssetVersion=1；只有迁移完成用户切换到新扫描，旧提醒页可保留历史兼容但新版本使用新路由。
- 会员额度只预留读取服务端权益，客户端不能修改 tier、额度或到期时间；首版不接支付。

### 前端 client

`utils/market-client.js`：search(keyword)、resolve(assetId)、quote(assetId)、quotes(assetIds)、chart(assetId,period)，解包 result，ok=false 抛带 hint 错误。

`utils/portfolio-client.js`：list()、add(assetId)、remove(assetId)、reorder(assetIds,revision)、saveRule(rule)、deleteRule(ruleId)。云端不可用只允许读取已标记的本地缓存/默认黄金条目，任何写操作不得误报成功。

## 实施任务

- [x] 先验证当前 76 项测试基线；保留已有工作目录变更。
- [x] 数据层先写失败测试，覆盖搜索过滤、时间与单位、多源降级、局部失败和图表口径；实现 marketData 及 market-client。
- [x] 自选与规则先写失败测试，覆盖用户身份、并发额度、重复添加、移除暂停、排序版本、迁移及规则版本；实现 portfolio 与 portfolio-client。
- [x] 前端列表/搜索/详情/标的提醒/汇总/我的页面，复用两套主题与图表；覆盖防抖、旧请求丢弃、保存失败、额度与导航。
- [x] 实现 sendTask 多标的模块：按去重标的拉行情、规则版本复核、消息标的深链、单次规则消费、全局每日预算与原子额度预占、旧用户兼容。
- [x] initDb 增加 portfolios/instruments/quoteCache/chartCache/searchCache/sendBudgets；不删除旧集合。
- [ ] 独立复核实现范围与可靠性；执行所有测试、JS 语法与 diff 检查。
- [ ] 微信开发者工具验证列表、搜索、详情、提醒 UI 和两套主题；整理部署步骤与实际限制。

## 发送预算与交易时间

首版用户每日常规最多 6 条，到价最多 4 条，两组独立；每标的同类最多 1 条/日，受微信授权余量约束。预算和授权预占在事务中执行，已确认失败退还，结果不明不重发。首次创建预算时计入当天旧发送记录，避免迁移重发。

黄金收盘简报保持 15:40；沪深股票收盘简报在 15:10 后，以当日有效收盘报价生成，休市日无当日报价则不发。定时「仅周一至周五」使用准确标签，不把工作周判断冒充完整交易日历。

## 验证命令

`node --test tests/*.test.js`；逐文件 `node --check`；`git diff --check`。真实数据适配仅低频只读检查，不主动发送微信消息。云端部署单独标记，不能把本地通过当作线上生效。

## 当前交付状态

整体功能代码已接入。数据兜底进一步增加新浪股票/黄金报价、上金所沪金图表、新浪伦敦金图表；供应商解析均保持数据时间和品种口径。

用户随后明确要求「先实现整体功能，不需要验证」。据此暂停剩余测试、网络实测、语法检查和原生界面验收；最后补充的黄金分时解析尚未验证。云端尚未部署，完整步骤及数据库权限配置见项目 README。此前测试或接口报告只代表对应代码时点，不能代替当前最终版本验收。
