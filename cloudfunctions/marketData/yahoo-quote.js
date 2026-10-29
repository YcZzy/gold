'use strict';
// Only regular-session metadata is used. Historical OHLC is deliberately excluded.
function symbol(asset) {
  if (asset.market !== 'US' || !/^[A-Z][A-Z0-9]*(?:\.[A-Z])?$/.test(asset.code)) throw Error('无效美股代码');
  return asset.code.replace('.', '-');
}
function url(asset) {
  return 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol(asset)) + '?range=1d&interval=1m&includePrePost=false';
}
function parse(raw, asset, now) {
  const meta=raw?.chart?.result?.[0]?.meta;
  if (raw?.chart?.error || !meta || meta.symbol !== symbol(asset) || meta.currency !== asset.currency ||
      !['NMS','NGM','NCM','NYQ','ASE','PCX','BTS'].includes(meta.exchangeName) ||
      meta.exchangeTimezoneName !== 'America/New_York' || meta.instrumentType !== (asset.kind === 'etf' ? 'ETF' : 'EQUITY'))
    throw Error('独立美股报价身份不匹配');
  const time=meta.regularMarketTime*1000;
  if (!Number.isFinite(meta.regularMarketPrice) || meta.regularMarketPrice <= 0 ||
      !Number.isInteger(meta.regularMarketTime) || time < Date.UTC(2000,0,1) || time > now+300000)
    throw Error('独立美股价格或时间无效');
  const previous=meta.range === '1d' && Number.isFinite(meta.chartPreviousClose) && meta.chartPreviousClose > 0 ? meta.chartPreviousClose : null;
  return {
    time, delayed:Number(meta.exchangeDataDelayedBy)>0,
    fields:{price:meta.regularMarketPrice,prevClose:previous,change:previous === null ? null : meta.regularMarketPrice-previous,
      changePct:Number.isFinite(meta.regularMarketChangePercent) ? meta.regularMarketChangePercent : previous === null ? null : (meta.regularMarketPrice/previous-1)*100,
      open:null,high:meta.regularMarketDayHigh,low:meta.regularMarketDayLow,volume:null,amount:null},
  };
}
module.exports={url,parse};
