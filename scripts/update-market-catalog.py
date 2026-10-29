#!/usr/bin/env python3
"""Refresh complete BSE / HKEX stock and ETF directories using Python stdlib.

No arguments performs a live refresh. --fixtures DIR reproduces a validated snapshot.
A failed request, inconsistent pagination or malformed workbook never replaces output.
"""
import argparse
from datetime import datetime, timezone
import http.cookiejar
import io
import json
from pathlib import Path
import re
import ssl
import tempfile
import urllib.parse
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile

BSE_PAGE = 'https://www.bse.cn/nq/listedcompany.html'
BSE_API = 'https://www.bse.cn/nqxxController/nqxxCnzq.do'
HKEX = 'https://www.hkex.com.hk/eng/services/trading/securities/securitieslists/ListOfSecurities.xlsx'
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}


def read_public(opener, url, referer):
    for attempt in range(2):
        try:
            return opener.open(urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': referer}), timeout=25).read()
        except urllib.error.URLError as error:
            if attempt or isinstance(error.reason, ssl.SSLCertVerificationError) or (isinstance(error, urllib.error.HTTPError) and error.code < 500):
                raise


def hk_records(body):
    with zipfile.ZipFile(io.BytesIO(body)) as workbook:
        shared = []
        if 'xl/sharedStrings.xml' in workbook.namelist():
            shared = [''.join(item.itertext()) for item in ET.fromstring(workbook.read('xl/sharedStrings.xml')).findall('s:si', NS)]
        sheet = ET.fromstring(workbook.read('xl/worksheets/sheet1.xml'))
        rows = []
        for row in sheet.findall('.//s:sheetData/s:row', NS):
            cells = {}
            for cell in row.findall('s:c', NS):
                column = re.sub(r'\d', '', cell.attrib['r'])
                if cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(cell.find('s:is', NS).itertext())
                else:
                    value = cell.findtext('s:v', default='', namespaces=NS)
                    if cell.attrib.get('t') == 's':
                        value = shared[int(value)]
                cells[column] = value.strip()
            rows.append(cells)
    header_index = next(i for i, row in enumerate(rows) if 'Stock Code' in row.values())
    headers = {value: column for column, value in rows[header_index].items()}
    required = ['Stock Code', 'Name of Securities', 'Category', 'Sub-Category', 'Trading Currency', 'ISIN']
    if any(key not in headers for key in required):
        raise ValueError('HKEX workbook schema changed')
    records = []
    for row in rows[header_index + 1:]:
        r = {key: row.get(headers[key], '') for key in required}
        category, subcategory = r['Category'], r['Sub-Category']
        kind = 'etf' if subcategory == 'Exchange Traded Funds' else 'stock' if category == 'Equity' and subcategory in ('Equity Securities (Main Board)', 'Equity Securities (GEM)') else None
        if not kind:
            continue
        code = r['Stock Code'].zfill(5)
        currency = {'RMB': 'CNY'}.get(r['Trading Currency'], r['Trading Currency'])
        if not re.fullmatch(r'\d{5}', code) or currency not in ('CNY', 'HKD', 'USD') or not r['Name of Securities']:
            raise ValueError('Invalid HKEX security')
        records.append({'market': 'HK', 'symbol': code, 'name': r['Name of Securities'], 'kind': kind, 'currency': currency, 'isin': r['ISIN'], 'category': category, 'subcategory': subcategory})
    if not records or len({r['symbol'] for r in records}) != len(records):
        raise ValueError('Empty or duplicate HKEX catalog')
    return records


def bse_records(pages):
    first = pages[0]
    if len(pages) != first['totalPages']:
        raise ValueError('Incomplete BSE pagination')
    for i, page in enumerate(pages):
        if page['number'] != i or page['totalPages'] != first['totalPages'] or page['totalElements'] != first['totalElements'] or len(page['content']) != page['numberOfElements']:
            raise ValueError('BSE pagination changed during refresh')
    rows = [row for page in pages for row in page['content']]
    if len(rows) != first['totalElements'] or len({r['xxzqdm'] for r in rows}) != len(rows):
        raise ValueError('Incomplete or duplicate BSE records')
    records = []
    for r in rows:
        if not re.fullmatch(r'920\d{3}', r['xxzqdm']) or not r['xxzqjc'] or r['xxfcbj'] != '2' or r['xxzqjb'] != 'T':
            raise ValueError('Unexpected BSE classification')
        records.append({'market': 'BJ', 'symbol': r['xxzqdm'], 'name': r['xxzqjc'], 'englishName': r.get('xxywjc', ''), 'isin': r.get('xxisin', ''), 'sourceDate': r['xxjsrq'], 'sourceTime': r.get('xxgxsj', ''), 'kind': 'stock', 'currency': 'CNY'})
    return records


def live():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def get(url, referer):
        return read_public(opener, url, referer)
    get(BSE_PAGE, BSE_PAGE)
    def page(index):
        params = {'page': str(index), 'typejb': 'T', 'xxfcbj[]': '2', 'xxzqdm': '', 'sortfield': 'xxzqdm', 'sorttype': 'asc'}
        raw = get(BSE_API + '?' + urllib.parse.urlencode(params), BSE_PAGE).decode('utf-8').strip()
        match = re.fullmatch(r'null\((.*)\)\s*;?', raw, re.S)
        if not match:
            raise ValueError('Unexpected BSE JSONP wrapper')
        result = json.loads(match[1])
        if not isinstance(result, list) or len(result) != 1:
            raise ValueError('Unexpected BSE response')
        return result[0]
    first = page(0)
    pages = [first] + [page(i) for i in range(1, first['totalPages'])]
    bj = bse_records(pages)
    hk = hk_records(get(HKEX, 'https://www.hkex.com.hk/'))
    return bj + hk, {'BJ': {'sourceUrl': BSE_PAGE, 'endpoint': BSE_API, 'requestParameters': {'page': '0..' + str(len(pages)-1), 'typejb': 'T', 'xxfcbj[]': '2', 'xxzqdm': '', 'sortfield': 'xxzqdm', 'sorttype': 'asc'}, 'pageCount': len(pages), 'totalElements': len(bj), 'complete': True, 'sourceDates': sorted({r['sourceDate'] for r in bj})}, 'HK': {'sourceUrl': HKEX, 'ordinaryStockAndEtfCount': len(hk)}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixtures', type=Path)
    parser.add_argument('--output', type=Path, default=Path(__file__).resolve().parents[1] / 'cloudfunctions/marketData/catalog.json')
    args = parser.parse_args()
    if args.fixtures:
        bj_source = json.loads((args.fixtures / 'bj-directory-2026-10-28.json').read_text())
        if not bj_source.get('complete') or len(bj_source['securities']) != bj_source['totalElements']:
            raise ValueError('Incomplete BSE snapshot')
        bj = [{**r, 'kind': 'stock', 'currency': 'CNY'} for r in bj_source['securities']]
        hk = hk_records((args.fixtures / 'hk-official-securities-2026-10-28.xlsx').read_bytes())
        records = bj + hk
        sources = {'BJ': {k: v for k, v in bj_source.items() if k != 'securities'}, 'HK': {'sourceUrl': HKEX, 'ordinaryStockAndEtfCount': len(hk)}}
    else:
        records, sources = live()
    if len({r['market'] + r['symbol'] for r in records}) != len(records):
        raise ValueError('Duplicate instrument identity')
    now = datetime.now(timezone.utc).isoformat()
    result = {'version': now + '-v2', 'retrievedAt': now, 'sources': sources, 'records': records}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile('w', dir=args.output.parent, encoding='utf-8', delete=False) as out:
            temporary = Path(out.name)
            json.dump(result, out, ensure_ascii=False, separators=(',', ':'))
            out.write('\n')
        temporary.replace(args.output)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()
    print(json.dumps({'output': str(args.output), 'BJ': sum(r['market'] == 'BJ' for r in records), 'HK': sum(r['market'] == 'HK' for r in records)}))

if __name__ == '__main__':
    main()
