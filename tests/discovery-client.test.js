const test=require('node:test');const assert=require('node:assert/strict');
const {createClient}=require('../utils/discovery-client');
test('discovery client sends mode envelopes and exports single stock modules',async()=>{
 const calls=[];const api=createClient({cloud:{callFunction:async x=>{calls.push(x);return {result:{ok:true,items:[],fetchedAt:10}}}}});
 await api.indices();await api.sectors({type:'concept',keyword:'芯片'});await api.members('sina:industry:new_fjzz',{page:2});await api.ranking('amount',2);await api.flowRanking(1);await api.flow('sh600519');await api.orderbook('sh600519');
 assert.equal(calls.length,7);assert.ok(calls.every(c=>c.name==='marketData' && c.data.action==='discovery'));
 assert.equal(calls[2].data.sectorId,'sina:industry:new_fjzz');assert.equal(calls[3].data.sort,'amount');assert.equal(calls[6].data.mode,'orderbook');
});
test('client caches failures at most 24 hours, preserving source time and distinguishing parameters',async()=>{
 let stamp=100000,fail=false;const storage=new Map();
 const api=createClient({getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),cloud:{callFunction:async()=>{if(fail)throw Error('offline');return {result:{ok:true,items:[{sourceTime:20}],sourceTime:null,fetchedAt:stamp}}}}},()=>stamp);
 await api.ranking('gainers');fail=true;stamp+=10000;
 const old=await api.ranking('gainers');assert.equal(old.stale,true);assert.equal(old.items[0].sourceTime,20);assert.equal(old.fetchedAt,100000);
 await assert.rejects(()=>api.ranking('losers'));stamp+=86400000;await assert.rejects(()=>api.ranking('gainers'));
});
test('business validation failures never return cached success',async()=>{
 let fail=false;const api=createClient({cloud:{callFunction:async()=>({result:fail?{ok:false,hint:'无效身份'}:{ok:true,items:[],fetchedAt:1}})}},()=>1);
 await api.indices();fail=true;await assert.rejects(()=>api.indices(),/无效身份/);
});
