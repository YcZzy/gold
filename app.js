// 金价行情小程序入口
// 数据源：东方财富（沪金 Au99.99）+ xaus.com（伦敦金 XAU/USD），多源降级见 utils/gold-api.js
// 提醒功能：云开发（云函数 + 云数据库 + 定时触发器），见 cloudfunctions/
const { cloudEnv } = require("./utils/app-config.js");

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error("当前基础库版本过低，请升级微信开发者工具基础库");
      return;
    }
    wx.cloud.init({
      env: cloudEnv,
      traceUser: true
    });
  },
  globalData: {}
});
