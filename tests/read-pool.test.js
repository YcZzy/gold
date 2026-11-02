const {test}=require('node:test');const assert=require('node:assert/strict');
const {forPlatform}=require('../utils/read-pool');
test('identical concurrent reads share a request but not mutable results',async()=>{
 const pool=forPlatform({});let finish,calls=0;
 const read=()=>{calls++;return new Promise(resolve=>{finish=resolve;});};
 const a=pool.run('quotes:a',read),b=pool.run('quotes:a',read);
 await Promise.resolve();assert.equal(calls,1);finish({rows:[1]});
 const [x,y]=await Promise.all([a,b]);x.rows.length=0;assert.deepEqual(y.rows,[1]);
 await pool.run('quotes:a',async()=>{calls++;return {rows:[2]};});assert.equal(calls,2);
});
test('platforms and parameters stay separate; failed reads can retry',async()=>{
 const p={},pool=forPlatform(p);assert.equal(pool,forPlatform(p));assert.notEqual(pool,forPlatform({}));
 await assert.rejects(pool.run('x',async()=>{throw Error('offline');}));
 assert.equal(await pool.run('x',async()=>2),2);
 const [a,b]=await Promise.all([pool.run('x',async()=>1),pool.run('y',async()=>2)]);assert.equal(a,1);assert.equal(b,2);
});

test('market client coalesces concurrent quotes while later refreshes still reach the server',async()=>{
 const market=require('../utils/market-client'),previous=global.wx;let calls=0;
 global.wx={getStorageSync(){},setStorageSync(){},cloud:{callFunction:async()=>{calls++;return {result:{ok:true,quote:{assetId:'sh600519',price:100}}};}}};
 try {
  const rows=await Promise.all([market.quote('sh600519'),market.quote('sh600519')]);
  assert.equal(calls,1);assert.equal(rows[0].quote.price,100);
  await market.quote('sh600519');assert.equal(calls,2);
 }finally{global.wx=previous;}
});

test('portfolio client shares overlapping lists but does not cache writes',async()=>{
 const {createClient}=require('../utils/portfolio-client');let lists=0,writes=0;
 const api=createClient({getStorageSync(){},setStorageSync(){},cloud:{callFunction:async({data})=>{
  if(data.action==='list')lists++;else writes++;
  return {result:{ok:true,items:[],rules:[],revision:writes}};
 }}});
 await Promise.all([api.list(),api.list()]);assert.equal(lists,1);
 await Promise.all([api.saveRule({id:'a'}),api.saveRule({id:'b'})]);assert.equal(writes,2);
 await api.list();assert.equal(lists,2);
});
