const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../cloudfunctions/portfolio');
const { memoryDb } = require('./helpers/asset-db');

const fixtures = [
  { id:'sh510300', code:'510300', market:'SH', kind:'etf', currency:'CNY', precision:3, timezone:'Asia/Shanghai' },
  { id:'bj920185', code:'920185', market:'BJ', kind:'stock', currency:'CNY', precision:2, timezone:'Asia/Shanghai' },
  { id:'hk82840', code:'82840', market:'HK', kind:'etf', currency:'CNY', precision:3, timezone:'Asia/Hong_Kong' },
  { id:'usBRK.B', code:'BRK.B', market:'US', kind:'stock', currency:'USD', precision:2, timezone:'America/New_York' },
  { id:'usSPY', code:'SPY', market:'US', kind:'etf', currency:'USD', precision:2, timezone:'America/New_York' },
].map(a => ({ name:a.id, unit:`${a.currency}/份`, secid:a.id, quoteCode:a.id, exchange:a.market, providers:{ tencentQuote:a.id }, supportsClose:true, ...a }));
function setup(transform = a => a) {
  const { db, tables } = memoryDb({
    portfolios:[{ _id:'u', openid:'u', items:[], rules:[], migrationVersion:1, revision:0 }],
    preferences:[{ _id:'u', multiAssetVersion:1 }],
    entitlements:[{ _id:'u', tier:'vip', expiresAt:Date.parse('2028-01-01') }],
  });
  const main = createHandler({ db, getOpenid:()=> 'u', now:()=>Date.parse('2026-10-28T02:00Z'),
    resolve:async id => transform(structuredClone(fixtures.find(a=>a.id===id))) });
  return { main, tables };
}

test('stock and ETF watchlists retain independently verified market and counter metadata', async () => {
  const f=setup();
  for (const a of fixtures) {
    const r=await f.main({action:'add', assetId:a.id});
    assert.equal(r.ok,true,r.hint);
    const saved=r.items.find(row=>row.id===a.id);
    for (const key of ['kind','currency','precision','timezone','supportsClose']) assert.equal(saved[key],a[key],key);
    assert.deepEqual(saved.providers,a.providers);
  }
  const r=await f.main({action:'reorder',assetIds:fixtures.map(a=>a.id).reverse(),revision:f.tables.portfolios[0].revision});
  assert.equal(r.ok,true,r.hint);
  assert.deepEqual(r.items.map(a=>a.id),fixtures.map(a=>a.id).reverse());
  assert.equal((await f.main({action:'remove',assetId:'usBRK.B'})).ok,true);
  assert.equal(f.tables.portfolios[0].items.includes('usBRK.B'),false);
});

test('ETF target prices use security precision while stocks keep their own limits', async () => {
  const f=setup();
  for(const id of ['sh510300','usBRK.B'])assert.equal((await f.main({action:'add',assetId:id})).ok,true);
  assert.equal((await f.main({action:'saveRule',assetId:'sh510300',type:'priceAbove',value:4.152,enabled:true})).ok,true);
  assert.equal((await f.main({action:'saveRule',assetId:'sh510300',type:'priceAbove',value:4.1521,enabled:true})).ok,false);
  assert.equal((await f.main({action:'saveRule',assetId:'usBRK.B',type:'priceBelow',value:542.991,enabled:true})).ok,false);
});

test('market identity, currency and close capability are validated on the server', async () => {
  for(const transform of [a=>({...a, market:'SH'}),a=>({...a,currency:'BTC'}),a=>({...a,providers:{tencentQuote:'usSPY&x=1'}})]) {
    assert.equal((await setup(transform).main({action:'add',assetId:'usSPY'})).ok,false);
  }
  const f=setup(a=>({...a,supportsClose:false}));
  assert.equal((await f.main({action:'add',assetId:'usSPY'})).ok,true);
  assert.equal((await f.main({action:'saveRule',assetId:'usSPY',type:'close',enabled:true})).ok,false);
});

test('malformed cross-market identifiers cannot enter a portfolio', async()=>{
  const f=setup();
  for(const id of ['usAAPL&x=1','hk700','bj920185/../../','usBRK.B.N?x=1','https://evil.test'])
    assert.equal((await f.main({action:'add',assetId:id})).ok,false);
});

test('zero decimal precision accepts integer targets and rejects fractional targets',async()=>{
  const f=setup(a=>({...a,precision:0}));
  assert.equal((await f.main({action:'add',assetId:'usSPY'})).ok,true);
  assert.equal((await f.main({action:'saveRule',assetId:'usSPY',type:'priceAbove',value:100,enabled:true})).ok,true);
  assert.equal((await f.main({action:'saveRule',assetId:'usSPY',type:'priceAbove',value:100.1,enabled:true})).ok,false);
});

test('explicit validated mapping states survive portfolio metadata checks',async()=>{
  const f=setup(a=>({...a,providers:{...a.providers,eastmoneyVerified:'metadata+raw-chart'}}));
  assert.equal((await f.main({action:'add',assetId:'usSPY'})).ok,true);
});
