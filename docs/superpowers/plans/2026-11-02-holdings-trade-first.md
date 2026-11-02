# Holdings Trade First Implementation Plan

> **For agentic workers:** Execute inline using executing-plans; request independent review after implementation.

**Goal:** Record trades without funding prerequisites and simplify header controls.
**Architecture:** Keep fixed-point cash flow internally; explicit funding enables optional cash tracking, gaps make balance unknown; position calculations remain independent.
**Tech Stack:** Node.js, WeChat WXML/WXSS, node:test.

- [x] Add failing engine/service tests: unfunded buy/sell, historical oversell, funded gap and complete old cash accounting.
- [x] Remove insufficient-cash rejection; track gap; expose null cash and equity for incomplete histories, preserve existing limits.
- [x] Add form/page tests for trade amount labels, fixed market value summary and moved actions; update obsolete cash rejection test.
- [x] Update holdings form, page, template and styles; preserve privacy and draft handling.
- [x] Run targeted and complete Node tests, wcc/wcsc compilation, independent review; document ledger deployment.
