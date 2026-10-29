# Official directory refresh verification — 2026-10-28

The BSE endpoint returned 353 securities across 18 pages, each with source date `xxjsrq=20261028`. The page and endpoint require a normal cookie jar: initial browser-style GET obtains the site's cookie and follows the same-origin redirect. No authentication or TLS bypass is needed. A client that does not retain cookies loops on a redirect to the same URL. Initial POST alone can return 307.

Source page: https://www.bse.cn/nq/listedcompany.html

Endpoint: https://www.bse.cn/nqxxController/nqxxCnzq.do

Verified GET query (POST with the same form parameters also worked):

```text
page=0&typejb=T&xxfcbj%5B%5D=2&xxzqdm=&sortfield=xxzqdm&sorttype=asc
```

A minimal read-only refresh can use Python's standard library. Pagination must be discovered from page 0 rather than hardcoding 18 or 353:

```python
import http.cookiejar
import json
import urllib.parse
import urllib.request

page_url = 'https://www.bse.cn/nq/listedcompany.html'
endpoint = 'https://www.bse.cn/nqxxController/nqxxCnzq.do'
opener = urllib.request.build_opener(
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
headers = {'User-Agent': 'Mozilla/5.0', 'Referer': page_url}
opener.open(urllib.request.Request(page_url, headers=headers), timeout=20).read()

def fetch(page):
    params = {'page': str(page), 'typejb': 'T', 'xxfcbj[]': '2',
              'xxzqdm': '', 'sortfield': 'xxzqdm', 'sorttype': 'asc'}
    url = endpoint + '?' + urllib.parse.urlencode(params)
    body = opener.open(urllib.request.Request(url, headers=headers),
                       timeout=20).read().decode('utf-8')
    assert body.startswith('null(') and body.rstrip().endswith(')')
    result = json.loads(body[5:body.rfind(')')])
    assert isinstance(result, list) and len(result) == 1
    result = result[0]
    assert result['number'] == page
    assert len(result['content']) == result['numberOfElements']
    return result

first = fetch(0)
pages = [first] + [fetch(i) for i in range(1, first['totalPages'])]
assert all(p['totalElements'] == first['totalElements'] and
           p['totalPages'] == first['totalPages'] for p in pages)
rows = [r for p in pages for r in p['content']]
assert len(rows) == first['totalElements']
assert len({r['xxzqdm'] for r in rows}) == len(rows)
assert all(len(r['xxzqdm']) == 6 and r['xxzqdm'].startswith('920') and
           r['xxzqdm'].isdigit() and r['xxzqjc'] and
           r['xxfcbj'] == '2' and r['xxzqjb'] == 'T' for r in rows)
print(len(rows), sorted({r['xxjsrq'] for r in rows}))
```

Refresh all pages before atomically replacing a known-good catalog. Keep endpoint, query, retrieval time, source date/time (`xxjsrq`, `xxgxsj`) and total count. An unsuccessful refresh must not replace the catalog with a partial list. A changed total is valid on a later trading day if all pages agree and the complete unique count matches; the observed 353 is evidence for this run, not a future invariant.

The HKEX full workbook is publicly downloadable and was updated 28/10/2026:

https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx

`Stock Code` is five-digit text. Columns `Category`, `Sub-Category`, `Trading Currency`, `ISIN`, and `RMB Counter` resolve allowed product type and exact counter identity. In this run, Main Board/GEM equities plus the exact `Exchange Traded Funds` subcategory yielded 3,209 distinct codes. Map official `RMB` to ISO `CNY`; retain HKD/USD. Reject all other categories unless scope is separately expanded. For example, `07200` is `Leveraged and Inverse` although Tencent reports `GP-FUND`, just as it does for ordinary ETFs. `00405` is a REIT. Shared ISINs do not merge 00700/80700 or 02840/82840/09840 because their counters and currencies differ.
