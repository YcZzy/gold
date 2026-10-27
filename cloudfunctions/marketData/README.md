# marketData

Server-authoritative, display-only public market data for SGE Au99.99, XAU/USD and Shanghai/Shenzhen A shares. No subscription messages are sent here.

Deploy this directory as the `marketData` WeChat cloud function with its local package dependencies. Initialize server-only collections `instruments`, `quoteCache`, `chartCache`, `searchCache` through the app's `initDb` function. Client writes and direct reads must be denied. Use a function timeout of at least 12 seconds. Remote requests are individually limited to 3 seconds; quote requests can use up to three provider routes (about nine seconds of remote time), while search and chart requests use at most two routes. Gold and stock quote routes run concurrently. No user IDs or profiles are stored in market collections.

## Actions

- `search {keyword}` → `{ok, assets, source, stale?}`. Chinese name, numeric code and name initials supported by the provider; full pinyin is not guaranteed. Filters to 沪A/深A results. Checks Eastmoney then independent Tencent smartbox, then the bounded cached catalog; an unavailable search differs from an empty successful result.
- `resolve {assetId}` → `{ok, asset}`. Canonical allowlisted gold IDs resolve locally. A stock missing from the catalog must match the provider's exact code and market before it is accepted.
- `quote {assetId}` → `{ok, asset, quote}`.
- `quotes {assetIds}` → `{ok, assets, quotes, errors}`; 1–30 IDs, partial per-asset failures.
- `chart {assetId, period}` → `{ok, asset, chart}`. Periods: `intraday`, `1mo`, `3mo`, `1y`, `5y`.

Failures are `{ok:false, err, hint}`. The mini-program client throws an Error carrying `hint`/`code` for these business failures and otherwise preserves the response envelope. If the cloud function cannot be reached, a read-only compatibility path resolves the two gold assets locally and calls the existing gold helpers for quotes/charts. It never supplies stock prices. Compatibility quotes carry `sourceTime:null`, `status:delayed`, and a 本地回退 source label; their legacy receipt timestamp is never treated as a verified provider timestamp. Compatibility charts are marked stale and preserve their actual bar/point labels. This path does not mask a structured unknown-asset or other cloud business error.

Stock quotes use Tencent GB18030 batch data, then Eastmoney per-symbol fallback, then an independent Sina batch quote request. Gold uses Eastmoney quotes, then the last actual Eastmoney intraday point, then independent Sina gold quotes. When multiple delayed sources are available, the quote with the newer valid provider timestamp is retained. Sina responses are decoded from GB18030 and matched to the exact expected quote variable. Unconfirmed SGE fields, including previous close and volume, remain null; the quoted percentage field is retained separately.

Charts use Eastmoney unadjusted `fqt=0` data first. Stock fallback requests Tencent **unadjusted** `day` rows and rejects `qfqday`/`hfqday`. Gold has independent chart routes: Au99.99 uses the Shanghai Gold Exchange `graph/Dailyhq` and `graph/quotations` endpoints; XAU uses Sina `GlobalFuturesService.getGlobalFuturesDailyKLine` and `getGlobalFuturesMinLine`. Historical candles are trimmed to the requested calendar period. JSONP is parsed as data without eval. Intraday adapters preserve actual dates/timestamps and skip future placeholders; SGE points whose prior-night date is ambiguous are omitted conservatively rather than assigned a guessed date. No fabricated average-price line is added.

The transport supplies Sina's required `Referer: https://finance.sina.com.cn/` and SGE's `Referer: https://www.sge.com.cn/` only for the exact allowlisted provider hosts.

`sourceTime` is the provider's timestamp, never the fetch time. Missing/invalid timestamps remain null; quotes older than 15 minutes have `status:delayed`. `fetchedAt` records local retrieval. `stale:true` means a cache was used after providers failed. Delayed live prices and historical charts remain available for display. **Alerts must independently require an appropriately fresh, valid `sourceTime`, and reject stale data.** A daily candle's time has day precision and is represented as midnight in Shanghai time, not a made-up current quote timestamp.

Quotes/charts older than seven days are not used as outage fallback. Search results expire after one day, are read as fresh for five minutes, and store no user identity. Cache writes sweep up to 100 expired records per collection, at most once per minute per warm runtime. Catalog fallback scans at most 100 stored instruments; it is not a full exchange directory.

## Tests and integration

`node --test tests/market-data.test.js` from the repository root exercises real pure adapters with captured provider shapes, transport-injected fallback behavior, cache age, exact asset resolution, and the mini-program client. Exports: `main`, `createService`, `stockAsset`, `canonical`, `parseTencentQuotes`, `parseTencentSearch`, `parseSinaQuotes`, `request`, `parseEastmoneyQuote`, `parseEastmoneyChart`, `parseTencentChart`, `decodeTencent`, `databaseStore`. `gold-history.js` exports `parseGoldHistory` and `parseGoldIntraday` for the independent gold chart adapters. Importing the main module does not initialize the cloud SDK. `createService({request, store, now})` accepts an injectable transport (`request(url, timeoutMs)`) and store (`get(collection,key)`, `set(collection,key,value)`, `search(keyword,100)`); `handle(event)` returns cloud response envelopes.

Public providers can fail intermittently. Partial errors and stale cache flags remain visible in the UI; a failed provider must not become a successful empty response or fabricated quote. Cloud deployment remains separate from implementation. Following the user's latest instruction to complete functionality without further verification, no additional tests, syntax checks, or live probes are being run for the latest intraday integration.
