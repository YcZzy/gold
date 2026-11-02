const {test}=require('node:test');
const assert=require('node:assert/strict');
const {memoryDb}=require('./helpers/asset-db');
const {createHandler}=require('../cloudfunctions/portfolio');
const {stockAsset}=require('../cloudfunctions/marketData/instruments');
const now=Date.parse('2026-11-02T06:00:00Z');
const assets=['600519','600418','688836','600000','600036'].map(code=>stockAsset('SH',code,'股票'+code));
function setup() {
 const {db,tables}=memoryDb({portfolios:[{_id:'u',openid:'u',items:assets.map(a=>a.id),rules:[],migrationVersion:1,revision:1}],preferences:[{_id:'u',multiAssetVersion:1}],
 instruments:assets.map(asset=>({_id:asset.id,asset,updatedAt:now-600000}))});
 const calls=[];
 const main=createHandler({db,getOpenid:()=> 'u',now:()=>now,resolve:async id=>{calls.push(id);return assets.find(a=>a.id===id);}});
 return {main,tables,calls};
}
test('listing five watchlist stocks reuses verified metadata without five nested cloud calls',async()=>{
 const f=setup();const r=await f.main({action:'list'});
 assert.equal(r.ok,true,r.hint);assert.equal(r.items.length,5);assert.equal(f.calls.length,0);
});
test('expired or mismatched metadata refreshes only affected assets',async()=>{
 const f=setup();f.tables.instruments[0].updatedAt=now-86400001;
 f.tables.instruments[1].asset.id='sh600000';
 const r=await f.main({action:'list'});assert.equal(r.ok,true,r.hint);
 assert.deepEqual(f.calls.sort(),['sh600418','sh600519']);
});
test('saving a rule still verifies its target asset through the authority',async()=>{
 const f=setup();const r=await f.main({action:'saveRule',assetId:assets[0].id,type:'priceAbove',value:100,enabled:true});
 assert.equal(r.ok,true,r.hint);assert.deepEqual(f.calls,[assets[0].id]);
});

test('verified LOF metadata stays valid when reused from the server directory',async()=>{
 const f=setup();const asset={...stockAsset('SH','501018','LOF'),identityVerified:'tencent',typeVerified:'tencent'};
 f.tables.portfolios[0].items=[asset.id];f.tables.instruments=[{_id:asset.id,asset,updatedAt:now}];
 const r=await f.main({action:'list'});assert.equal(r.ok,true,r.hint);assert.equal(r.items[0].kind,'lof');assert.equal(f.calls.length,0);
});
