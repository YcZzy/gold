# LOF 数据源验证（2026-10-29）

本地只读实际访问腾讯公开搜索/行情接口，保留原始响应于 `tests/fixtures/lof/`。

- 搜索：`https://smartbox.gtimg.cn/s3/?q=代码&t=all`。161725 和 502000 返回 `LOF`；160216 和 501018 返回 `QDII-LOF`；510300 返回 `ETF`。名称仅作显示，不作类型证据。
- 行情：`https://qt.gtimg.cn/q=sz161725,sh501018,sz160216,sh502000,sh510300`，GB18030 解码。四个 LOF 的第 62 项（零基 `p[61]`）均为 `LOF`；510300 为 `ETF`。代码字段 `p[2]` 与请求代码一致，币种字段 `p[82]` 均为 `CNY`，价格字段至少三位小数。接入验证同时要求该人民币币种字段，缺失或其他币种均拒绝。响应行情日期为 2026-10-29，约 10:17 北京时间。
- 初始候选范围限上海 `501xxx`、`502xxx`，深圳 `16xxxx`；范围只是候选资格，未验证的代码不能通过 resolve、缓存恢复、自选新增或备源兜底接入。每个接入 LOF 都必须得到腾讯精确代码及 `LOF` 报价类型双重证据。腾讯搜索未知类型、错配 ETF 类型或无报价证据时拒绝；不按名称识别。
- 交易所公开材料交叉核对代码前缀：上交所 [501219 LOF 年报](https://www.sse.com.cn/disclosure/fund/announcement/c/new/2026-03-31/501219_20260331_W7KZ.pdf)、[502040 LOF 终止上市公告](https://etf.sse.com.cn/disclosure/ssenotice/c/5741023.shtml)；深交所 [160416 LOF 停牌公告](https://investor.szse.cn/disclosure/notice/temp/t20260304_619272.html)、[161037 LOF 上市公告](https://www.szse.cn/disclosure/notice/t20170508_517003.html)。502040 公告仅用于核对代码前缀，不意味着该证券仍可交易。本次不是完整在市 LOF 名录验证，不宣称候选范围中所有代码均为有效上市 LOF。
- 使用生产 `createService` 默认网络请求执行真实只读搜索 `501018`，返回 `ok:true`、`source:tencent`、`sh501018`、`kind:lof`、`precision:3`，身份和类型证据均为腾讯。
- 东财 LOF 搜索类型尚未独立验证，暂不据此接入；主搜索为空或失败时使用腾讯搜索及报价确认。已有腾讯身份类型证据的 LOF 可复用既有东财/新浪备源行情路径；备源数值不构成新的类型证据。

后端元数据为 `kind: 'lof'`、`currency: 'CNY'`、`unit: '元/份'`，最低精度 3；行情实际更多小数时按现有机制保留。ETF 验证仍严格要求 `ETF`，不会被 LOF 放宽。

新增测试先运行得到 8 项失败，再实现；补充搜索缓存保护及备源回归后，以下 106 项全部通过：

```sh
node --test tests/lof.test.js tests/annotations.test.js tests/portfolio.test.js tests/portfolio-markets.test.js tests/multi-market-data.test.js tests/instrument-evidence.test.js tests/market-data.test.js
```
