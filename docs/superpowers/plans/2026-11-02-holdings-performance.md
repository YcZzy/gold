# Holdings Performance Implementation Plan

> **For agentic workers:** Execute inline using executing-plans; preserve existing workspace changes.

**Goal:** Reduce holdings cloud calls and waiting while keeping recording and refresh clear.

**Architecture:** Page-scoped 15s snapshots and overlapping client reads; validated server metadata cache; quote only open positions, cached quotes for note saves, bounded quote waits. Existing revision and receipt rules remain authoritative.

**Tech Stack:** WeChat Mini Program WXML/WXSS, Node.js cloud functions and node:test.

### Task 1: Cloud call budget
- [x] Add tests in tests/ledger-service.test.js for cached metadata, stale fallback, closed positions, cached-note valuation and timeout.
- [x] Run `node --test tests/ledger-service.test.js`, confirm new assertions fail.
- [x] Update cloudfunctions/ledger/index.js: instruments age <86400000 and verifyAsset; replay quantities to select quote IDs; note reads quoteCache and marks stale; Promise.race quoteTimeoutMs default 5000 and clear timers.
- [x] Run targeted service tests.

### Task 2: Client and page lifecycle
- [x] Add tests for overlapping list reads, mutation invalidation, immediate return reuse, explicit refresh and local asset selection.
- [x] Run targeted tests, confirm expected failures.
- [x] Update utils/ledger-client.js pending list promise with invalidation before/after writes; pages/holdings/holdings.js page-scoped freshness, local verified candidate selection and asset Map for history.
- [x] Run targeted client/page tests.

### Task 3: Interaction and verification
- [x] Add direct history, overview details and refresh controls with accessible labels to holdings.wxml and compact wrapping toolbar in holdings.wxss. Clear position query/sort/closed as a single action for no-result filters.
- [x] Run `node --test tests/*.test.js`; inspect failures and changed-file diff.
- [x] Attempt available native template/style compiler and record actual result.
- [x] Write docs/holdings-performance-2026-11-02.md with exact call budgets and deployment instructions. No cloud deployment or commits of unrelated work.
