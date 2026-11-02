# Watchlist Group Header Implementation Plan

**Goal:** Integrate group navigation into the list card without duplicated titles.
**Architecture:** Render scrollable group tabs or the existing plain title in the card heading, with the management button as a fixed sibling.
**Tech Stack:** WeChat WXML/WXSS.

- [x] Move existing group-scroll inside watchlist-heading and show plain title only for management or no groups.
- [x] Give scroll region flex:1/min-width:0 and fixed button spacing; use existing selected underline, consistent title size and a compact heading height.
- [x] Run existing workspace and page tests; compile WXML/WXSS using native WeChat compilers; inspect diff for unintended behavior changes.

验证结果：77项相关测试通过；微信wcc/wcsc编译通过，git diff --check通过。仅更新首页前端，无需部署云函数；尚未在模拟器截图复核。
