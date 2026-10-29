const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');
const i=require('../cloudfunctions/marketData/instruments');const m=require('../cloudfunctions/marketData');
const body=fs.readFileSync(require('node:path').join(__dirname,'fixtures/lof/tencent-quotes-2026-10-29.txt'),'utf8');
const searches=require('./fixtures/lof/tencent-search-2026-10-29.json');
test('LOF search uses observed LOF and QDII-LOF provider types and exact quote evidence',()=>{
 for(const id of ['sz161725','sz160216','sh501018','sh502000']){
  const a=i.canonical(id);assert.equal(a.kind,'lof');assert.equal(a.unit,'元/份');assert.ok(a.precision>=3);assert.equal(a.currency,'CNY');
  const candidates=m.parseTencentSearch(searches.find(s=>s.code===a.code).raw);assert.equal(candidates.find(c=>c.id===id)?.kind,'lof');
  const p=i.quoteFields(body,a);assert.equal(p[61],'LOF');const verified=i.verifiedQuoteAsset(a,p);assert.equal(verified?.typeVerified,'tencent');assert.equal(i.restoreAsset(verified).kind,'lof');
  for(const currency of ['USD','']){const wrongCurrency=[...p];wrongCurrency[82]=currency;assert.equal(i.verifiedQuoteAsset(a,wrongCurrency),null);}
  for(const wrong of ['ETF','GP-A','', 'FUND']){const copy=[...p];copy[61]=wrong;assert.equal(i.verifiedQuoteAsset(a,copy),null);}
 }
 assert.equal(i.searchCandidates('sz~161725~白酒ETF~x~ETF').length,0);
 assert.equal(i.searchCandidates('sh~510300~沪深LOF~x~LOF').length,0);
 assert.equal(i.searchCandidates('sz~150001~未知LOF~x~LOF').length,0);
 const etf=i.canonical('sh510300'),p=i.quoteFields(body,etf);p[61]='LOF';assert.equal(i.verifiedQuoteAsset(etf,p),null);
 assert.throws(()=>i.restoreAsset({...i.canonical('sz161725'),kind:'etf'}));
});
test('LOF metadata reaches portfolio and supports three decimal price rules',async()=>{
 const {memoryDb}=require('./helpers/asset-db');const {createHandler}=require('../cloudfunctions/portfolio');const {db}=memoryDb({portfolios:[{_id:'u',items:[],rules:[],revision:0,migrationVersion:1}],preferences:[{_id:'u',multiAssetVersion:1}]});
 const main=createHandler({db,getOpenid:()=> 'u',resolve:async id=>i.verifiedQuoteAsset(i.canonical(id),i.quoteFields(body,i.canonical(id)))});
 const r=await main({action:'add',assetId:'sz161725'});assert.equal(r.ok,true,r.hint);assert.equal(r.items[0].kind,'lof');assert.equal(r.items[0].unit,'元/份');
 assert.equal((await main({action:'saveRule',assetId:'sz161725',type:'priceAbove',enabled:true,value:0.531})).ok,true);
 assert.equal((await main({action:'saveRule',assetId:'sz161725',type:'priceAbove',enabled:true,value:0.5311})).ok,false);
});
test('search/resolve/cache paths require quote identity and keep LOF distinct from ETF',async()=>{
 const storeMap=new Map();const store={get:async(c,k)=>storeMap.get(c+':'+k),set:async(c,k,v)=>storeMap.set(c+':'+k,v),search:async()=>[]};
 const service=m.createService({store,request:async url=>{if(url.includes('smartbox'))return searches.find(s=>s.code==='501018').raw;if(url.includes('qt.gtimg'))return body;throw Error('unavailable');}});
 const r=await service.handle({action:'search',keyword:'501018'});assert.equal(r.ok,true,r.hint);assert.equal(r.assets.find(a=>a.id==='sh501018')?.kind,'lof');
 const resolved=await service.handle({action:'resolve',assetId:'sh501018'});assert.equal(resolved.ok,true,resolved.hint);assert.equal(resolved.asset.kind,'lof');
 const blocked=m.createService({store:{get:async()=>null,set:async()=>{},search:async()=>[]},request:async url=>url.includes('smartbox')?searches.find(s=>s.code==='501018').raw:body.replaceAll('~LOF~','~ETF~')});
 assert.equal((await blocked.handle({action:'search',keyword:'501018'})).assets.some(a=>a.id==='sh501018'),false);
});
test('empty Eastmoney search still reaches Tencent LOF and unknown quote types stay disconnected',async()=>{
 const make=quoteBody=>m.createService({store:{get:async()=>null,set:async()=>{},search:async()=>[]},request:async url=>{
  if(url.includes('searchapi.eastmoney'))return JSON.stringify({QuotationCodeTable:{Data:[]}});
  if(url.includes('smartbox'))return searches.find(s=>s.code==='161725').raw;
  if(url.includes('qt.gtimg'))return quoteBody;
  throw Error('unavailable');
 }});
 const result=await make(body).handle({action:'search',keyword:'161725'});assert.equal(result.assets[0]?.kind,'lof');
 const bad=await make(body.replaceAll('~LOF~','~FUND~')).handle({action:'resolve',assetId:'sz161725'});assert.equal(bad.ok,false);
 const unverified=i.canonical('sz161725');assert.throws(()=>i.restoreAsset(unverified));
 const {metadata}=require('../cloudfunctions/portfolio/securities');assert.equal(metadata(unverified,unverified.id),null);
});
test('verified LOF keeps identity in quote and backup paths and rejects unverified search cache',async()=>{
 const observed=i.verifiedQuoteAsset(i.canonical('sz161725'),i.quoteFields(body,i.canonical('sz161725')));
 const parsed=m.parseTencentQuotes(body,[observed],Date.parse('2026-10-29T02:20:00Z'));assert.equal(parsed[0]?.assetId,observed.id);
 const cache=new Map([['instruments:sz161725',{asset:observed}]]);
 const service=m.createService({now:()=>Date.parse('2026-10-29T02:20:00Z'),store:{get:async(c,k)=>cache.get(c+':'+k),set:async(c,k,v)=>cache.set(c+':'+k,v),search:async()=>[]},request:async url=>{
  if(url.includes('push2.eastmoney'))return JSON.stringify({data:{f57:'161725',f58:'白酒基金LOF',f59:3,f43:531,f60:528,f46:525,f44:533,f45:525,f86:1793240400}});
  throw Error('primary unavailable');
 }});
 const result=await service.handle({action:'quote',assetId:observed.id});assert.equal(result.ok,true,result.hint);assert.equal(result.asset.kind,'lof');assert.equal(result.asset.typeVerified,'tencent');assert.equal(result.quote.source,'eastmoney');
 const spoof=i.canonical('sz161725');const untrusted=m.createService({store:{get:async(c)=>c==='searchCache'?{assets:[spoof],fetchedAt:Date.now()}:null,set:async()=>{},search:async()=>[]},request:async()=>{throw Error('offline')}});
 const rejected=await untrusted.handle({action:'search',keyword:'161725'});assert.equal((rejected.assets||[]).some(a=>a.id===spoof.id),false);
});
