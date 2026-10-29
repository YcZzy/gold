const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../cloudfunctions/marketData');
const {usAsset}=require('../cloudfunctions/marketData/instruments');
const fixtures=require('./fixtures/markets/us-backup-yahoo-responses.json').responses;
const NOW=Date.parse('2026-10-28T09:00Z');

test('independent US quotes use verified regular price and original epoch, never premarket or history baseline',()=>{
  assert.equal(typeof m.parseYahooQuote,'function');
  for(const [symbol,suffix,kind]of [['MSFT','OQ','stock'],['TSLA','OQ','stock'],['QQQ','OQ','etf'],['KO','N','stock'],['VOO','AM','etf']]){
    const a=usAsset(symbol+'.'+suffix,symbol,kind),raw=fixtures['us-backup-yahoo-'+symbol.toLowerCase()];
    const q=m.parseYahooQuote(raw,a,NOW),meta=raw.chart.result[0].meta;
    assert.equal(q.price,meta.regularMarketPrice);
    assert.equal(q.sourceTime,meta.regularMarketTime*1000);
    assert.equal(q.prevClose,null,'long-range chart baseline is not previous trading close');
    assert.equal(q.volume,null);
    assert.equal(q.source,'yahoo');
  }
});

test('Yahoo price metadata must match exact US security, currency, type and timezone',()=>{
  assert.equal(typeof m.parseYahooQuote,'function');
  const a=usAsset('MSFT.OQ','微软'),raw=fixtures['us-backup-yahoo-msft'];
  for(const changes of [{symbol:'MSFTX'},{currency:'HKD'},{instrumentType:'ETF'},{exchangeName:'PNK'},{exchangeTimezoneName:'Asia/Shanghai'},{regularMarketPrice:0},{regularMarketTime:NOW/1000+3600}]){
    const copy=structuredClone(raw);Object.assign(copy.chart.result[0].meta,changes);
    assert.throws(()=>m.parseYahooQuote(copy,a,NOW));
  }
});

test('a non-example US stock retains independent quotes when Tencent and Eastmoney fail',async()=>{
  const a={...usAsset('MSFT.OQ','微软'),identityVerified:'tencent',typeVerified:'tencent'};
  const map=new Map([['instruments:'+a.id,{asset:a}]]);
  const service=m.createService({now:()=>NOW,store:{get:async(c,k)=>map.get(c+':'+k),set:async(c,k,v)=>map.set(c+':'+k,v),search:async()=>[]},
    request:async (url,timeout)=>{if(url.startsWith('https://query1.finance.yahoo.com/')){assert.ok(timeout>=5000);return fixtures['us-backup-yahoo-msft'];}throw Error('offline');}});
  const r=await service.handle({action:'quote',assetId:a.id});
  assert.equal(r.ok,true,r.hint);
  assert.equal(r.quote.source,'yahoo');assert.equal(r.quote.stale,false);
  assert.equal(r.quote.sourceTime,fixtures['us-backup-yahoo-msft'].chart.result[0].meta.regularMarketTime*1000);
});
