const {test}=require('node:test');
const assert=require('node:assert/strict');
const m=require('../cloudfunctions/marketData');
const {usAsset}=require('../cloudfunctions/marketData/instruments');
const {memoryDb}=require('./helpers/asset-db');
const NOW=Date.parse('2026-10-28T09:00Z');
function memory(asset){const map=new Map([['instruments:'+asset.id,{asset}]]);return{map,get:async(c,k)=>map.get(c+':'+k),set:async(c,k,v)=>map.set(c+':'+k,v),search:async()=>[]};}
test('a regular quote refresh preserves an independently verified US mapping',async()=>{
  const a={...usAsset('MSFT.OQ','微软'),secid:'105.MSFT',identityVerified:'tencent',typeVerified:'tencent',providers:{...usAsset('MSFT.OQ').providers,eastmoney:'105.MSFT',eastmoneyVerified:'metadata+raw-chart'}};
  const store=memory(a),p=Array(73).fill('');Object.assign(p,{1:'微软',2:'MSFT.OQ',3:'531.33',4:'532.60',30:'2026-10-27 16:00:01',35:'USD',56:'GP'});
  const service=m.createService({store,now:()=>NOW,request:async url=>{if(url.includes('qt.gtimg'))return 'v_usMSFT="'+p.join('~')+'";';throw Error('offline');}});
  const r=await service.handle({action:'quote',assetId:a.id});assert.equal(r.ok,true,r.hint);
  assert.equal(r.asset.providers.eastmoney,'105.MSFT');
  assert.equal(r.asset.secid,'105.MSFT');
  assert.equal(store.map.get('instruments:'+a.id).asset.providers.eastmoneyVerified,'metadata+raw-chart');
});
test('a preserved US mapping works in the same delayed-primary quote request',async()=>{
  const a={...usAsset('MSFT.OQ','微软'),secid:'105.MSFT',identityVerified:'tencent',typeVerified:'tencent',providers:{...usAsset('MSFT.OQ').providers,eastmoney:'105.MSFT',eastmoneyVerified:'metadata+raw-chart'}};
  const store=memory(a),p=Array(73).fill('');Object.assign(p,{1:'微软',2:'MSFT.OQ',3:'531.33',4:'532.60',30:'2026-10-27 16:00:01',35:'USD',56:'GP'});
  const service=m.createService({store,now:()=>NOW,request:async url=>{
    if(url.includes('qt.gtimg'))return 'v_usMSFT="'+p.join('~')+'";';
    if(url.includes('stock/get?secid=105.MSFT'))return {data:{f13:105,f57:'MSFT',f59:2,f43:53400,f60:53300,f86:NOW/1000}};
    throw Error('offline');
  }});
  const r=await service.handle({action:'quote',assetId:a.id});assert.equal(r.ok,true,r.hint);
  assert.equal(r.quote.source,'eastmoney');assert.equal(r.quote.price,534);
});
test('search refresh cannot erase previously verified earlier history',async()=>{
  const a={...m.canonical('sh600000'),name:'浦发银行',historyAvailableFrom:'2020-01-01',historyRangeConfirmedFrom:'2020-01-01'};
  const store=memory(a),service=m.createService({store,now:()=>NOW,request:async url=>{
    if(url.includes('searchapi'))return {QuotationCodeTable:{Data:[{Code:'600000',Name:'浦发银行',MktNum:'1',SecurityTypeName:'沪A'}]}};
    if(url.includes('smartbox'))return 'v_hint="N";';throw Error('offline');}});
  assert.equal((await service.handle({action:'search',keyword:'浦发银行'})).ok,true);
  const saved=store.map.get('instruments:'+a.id).asset;
  assert.equal(saved.historyAvailableFrom,'2020-01-01');assert.equal(saved.historyRangeConfirmedFrom,'2020-01-01');
});
test('cross-runtime metadata writes retain earlier evidence transactionally',async()=>{
  const a={...m.canonical('sh600000'),name:'浦发银行',historyAvailableFrom:'2020-01-01'};
  const {db,tables}=memoryDb({instruments:[{_id:a.id,asset:a}]});const store=m.databaseStore(db);
  assert.equal(typeof store.setInstrument,'function');
  await Promise.all([store.setInstrument({...a,historyAvailableFrom:'2025-01-01'},NOW),store.setInstrument({...m.canonical(a.id),name:a.name},NOW)]);
  assert.equal(tables.instruments[0].asset.historyAvailableFrom,'2020-01-01');
});
