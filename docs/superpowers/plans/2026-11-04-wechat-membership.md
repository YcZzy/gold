# 微信虚拟支付会员实施计划

**目标** 接入 990 分道具直购，确认付款后发放 30 天会员。

**架构** membership 云函数独立部署。发货通知、主动查单和定时补偿共用事务发货。现有 portfolio 云函数继续负责上限校验。

- [x] 在 tests/membership.test.js 验证双签名、账号隔离、订单匹配和发货幂等，先运行测试确认失败。
- [x] 在 cloudfunctions/membership 实现签名、服务端查单、事务发货、推送处理和定时补偿。通过 initDb 初始化订单集合。
- [x] 在 pages/mine 接入购买和待确认订单查询。在自选新增入口提供会员入口。
- [x] 修正 cloudfunctions/portfolio/workspace.js 对到期后零新增导入的校验。
- [x] 运行 node --test tests/*.test.js 和 git diff --check，记录部署与微信联调步骤。
