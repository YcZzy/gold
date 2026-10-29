'use strict';
// Public-data read-only acceptance. No cloud SDK, user database or real messages.
const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {createService,request}=require('../cloudfunctions/marketData');
function store(){const map=new Map();return{get:async(c,k)=>map.get(c+':'+k),set:async(c,k,v)=>map.set(c+':'+k,v),search:async q=>[...map.entries()].filter(([k])=>k.startsWith('instruments:')).map(([,v])=>v).filter(r=>(r.asset.name+' '+r.asset.code).toLowerCase().includes(q.toLowerCase()))};}
const assets=[
  ['sh600519','茅台','stock','CNY'],['sz000001','000001','stock','CNY'],
  ['sh510300','510300','etf','CNY'],['sz159915','159915','etf','CNY'],
  ['bj920185','贝特瑞','stock','CNY'],['hk00700','腾讯','stock','HKD'],
  ['hk02800','02800','etf','HKD'],['hk82840','82840','etf','CNY'],['hk09840','09840','etf','USD'],
  ['usAAPL','AAPL','stock','USD'],['usSPY','SPY','etf','USD'],['usBRK.B','BRK.B','stock','USD'],['usMSFT','MSFT','stock','USD'],
];
const report={checkedAt:new Date().toISOString(),environment:'local-node-public-readonly',tests:[]};
const verifiedStore=store();
const service=createService({store:verifiedStore});
function ok(r){assert.equal(r.ok,true,r.hint);return r;}
async function check(label,fn){const started=Date.now();try{const detail=await fn();report.tests.push({label,ok:true,elapsedMs:Date.now()-started,...detail});console.log('PASS',label,JSON.stringify(detail));}catch(e){report.tests.push({label,ok:false,elapsedMs:Date.now()-started,error:e.message});console.log('FAIL',label,e.message);}}
function metadata(a,id,kind,currency){assert.equal(a.id,id);assert.equal(a.kind,kind);assert.equal(a.currency,currency);assert.ok(a.name&&a.name!==a.code);assert.ok(a.timezone);assert.ok(Number.isInteger(a.precision));}
async function run(){
  for(const [id,keyword,kind,currency] of assets){
    await check('search:'+id,async()=>{const r=ok(await service.handle({action:'search',keyword}));const a=r.assets.find(a=>a.id===id);assert.ok(a,'exact asset missing');metadata(a,id,kind,currency);return{source:r.source,name:a.name,kind:a.kind,currency:a.currency};});
    await check('resolve:'+id,async()=>{const r=ok(await service.handle({action:'resolve',assetId:id}));metadata(r.asset,id,kind,currency);return{name:r.asset.name,precision:r.asset.precision,timezone:r.asset.timezone};});
  }
  await check('mixed-batch-quotes',async()=>{
    const r=ok(await service.handle({action:'quotes',assetIds:assets.map(a=>a[0])}));assert.deepEqual(r.errors,[]);assert.equal(r.quotes.length,assets.length);
    const rows=r.quotes.map(q=>{assert.ok(q.price>0&&Number.isFinite(q.sourceTime)&&q.sourceTime>0);assert.equal(q.stale,false);assert.ok(q.sessionDate);return{assetId:q.assetId,price:q.price,source:q.source,sourceTime:new Date(q.sourceTime).toISOString(),sessionDate:q.sessionDate,status:q.status,marketState:q.marketState};});
    return{quotes:rows};
  });
  for(const [id] of assets)for(const period of ['intraday','1mo','3mo','1y','5y'])await check('chart:'+id+':'+period,async()=>{
    const r=ok(await service.handle({action:'chart',assetId:id,period}));assert.equal(r.asset.id,id);assert.equal(r.chart.stale,false);const rows=r.chart.points||r.chart.candles;assert.ok(rows&&rows.length);assert.ok(Number.isFinite(r.chart.sourceTime));
    return{source:r.chart.source,timezone:r.chart.timezone,count:rows.length,first:rows[0].time,last:rows.at(-1).time};
  });
  // Reuse server-verified ETF identities, but require an actual independent price (not stale cache).
  const backup=createService({store:verifiedStore,request:async(url,timeout)=>{if(url.startsWith('https://qt.gtimg.cn/'))throw Error('intentional Tencent quote outage');return request(url,timeout);}});
  for(const id of ['sh510300','bj920185','hk02800','usMSFT'])await check('independent-quote-fallback:'+id,async()=>{const r=ok(await backup.handle({action:'quote',assetId:id}));assert.notEqual(r.quote.source,'tencent');assert.equal(r.quote.stale,false);assert.ok(r.quote.price>0&&r.quote.sourceTime>0);return{source:r.quote.source,sourceTime:new Date(r.quote.sourceTime).toISOString()};});
  const chartBackup=createService({store:store(),request:async(url,timeout)=>{if(url.startsWith('https://web.ifzq.gtimg.cn/'))throw Error('intentional primary chart transport outage');return request(url,timeout);}});
  for(const id of ['hk02800','usSPY','usBRK.B'])for(const period of ['intraday','5y'])await check('chart-transport-fallback:'+id+':'+period,async()=>{const r=ok(await chartBackup.handle({action:'chart',assetId:id,period}));assert.equal(r.chart.stale,false);const rows=r.chart.points||r.chart.candles;assert.ok(rows.length);return{source:r.chart.source,count:rows.length,independentDataFeed:false};});
  for(const id of ['hk13005','usAAPL&x=1','bj835185'])await check('reject:'+id,async()=>{const r=await service.handle({action:'resolve',assetId:id});assert.equal(r.ok,false);return{rejected:true};});
  report.passed=report.tests.filter(t=>t.ok).length;report.failed=report.tests.length-report.passed;
  const day=process.env.MARKET_VALIDATION_DATE || new Date(Date.now()+8*3600000).toISOString().slice(0,10),output=path.join(__dirname,'../docs/market-integration-smoke-'+day+'.json');
  report.validationDate=day;
  fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n');console.log('RESULT',JSON.stringify({passed:report.passed,failed:report.failed,report:output}));process.exitCode=report.failed?1:0;
}
run().catch(e=>{console.error(e);process.exitCode=1;});
