# Liquid Glass Navigation Implementation Plan

**Goal:** 为现有原生小程序提供纸感 / 黑金双主题悬浮玻璃导航和小面积玻璃控件。

**Architecture:** 保留 WebView、页面路由和行情 Canvas。自定义 TabBar 负责路由与选中胶囊，glass-surface 负责材质；主题模块通过当前页面的 getTabBar 同步主题。只在已确认页面显示后更新选中态，切换失败恢复原路由；不将导航请求当作页面已切换。

**Tech Stack:** WXML、WXSS、CommonJS、node:test。原生背景模糊为渐进增强，半透明着色、描边与高光提供独立兜底；无 WebGL 折射。

用户已批准方案 A 并要求开始修改。本次在现有未提交业务改动基础上增量修改，不提交其他工作。

## Tasks

- [x] 1. tests/glass-tabbar.test.js：通过 VM 加载组件，验证深色初始化、真实路由恢复、重复点击、切换失败、快速点击、主题同步。先运行并确认新行为缺失。
- [x] 2. components/glass-surface/index.{js,json,wxml,wxss} 和 styles/glass.wxss：提供分层玻璃材质、双主题令牌、无模糊模式；背景与内容分层。
- [x] 3. custom-tab-bar/index.{js,json,wxml,wxss}：三个原有入口，原生 button、读屏名称、选中态；140–200ms transform 动效；减少动态效果媒体查询。wx.switchTab 后由目标页面生命周期确认状态，不用延时阻塞导航。
- [x] 4. app.json 启用 custom；utils/theme.js 在自定义栏存在时调用 syncFromPage，其他环境保留原生兜底。复用三个 Tab 页已有的 onShow → theme.applyChrome，同时组件 attached / pageLifetimes.show 同步，消除生命周期次序差异。
- [x] 5. 三个 Tab 页使用统一底部占位（导航高度 + 悬浮间距 + 安全区）；首页添加和我的主题按钮使用小面积玻璃材质；不更改主行情数据样式。
- [x] 6. 执行 node --test tests/*.test.js，检查组件引用、图标和 JSON/WXML；使用可用的微信开发工具编译预览，记录真机验证限制。更新 README 和此计划。

## Acceptance

- 冷启动、返回 Tab、主题切换和首次云端恢复后，导航主题与选中路由一致。
- 切换失败可继续点击，快速连点不能留下错误选中项。
- 最后一个控件可滚动到浮栏之上，安全区不遮挡入口；点击区域至少 44px 高。
- 动画仅修改 transform/opacity；静止时无循环动画；减少动效时关闭过渡。
- 不支持 backdrop-filter 时仍能清晰阅读，玻璃内容本身不模糊。

## Verification record

- `node --test tests/*.test.js`：238 项通过，0 失败。新导航测试 11 项；先观察缺失组件导致失败，再实现；缓存返回与源 success 时序另做红绿回归。
- 微信开发者工具：CLI `auto` 成功，模拟器已编译显示；观察纸感首页、我的页面切换、黑金材质，以及长页滚到底部后的安全留白。最终代码已重新编译显示纸感首页。
- 独立代码复核发现两处动画问题并修正：隐藏源组件不再消费目标动画起点；缓存页面重置起点时关闭 transition，移到目标时才开启。
- `git diff --check` 通过。工作区原有业务改动保留，未自动提交或发布。
- iOS / 安卓真机的背景模糊兼容、减少动态效果与低端机性能仍需扫码验证；模拟器验证不能替代真机结论。
