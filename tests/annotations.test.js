const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createHandler}=require('../cloudfunctions/portfolio');
const {memoryDb}=require('./helpers/asset-db');
function setup(){
 const {db,tables}=memoryDb({portfolios:['u','v'].map(_id=>({_id,items:['gold-au9999','gold-xauusd'],rules:[{id:'r',assetId:'gold-au9999',type:'close',enabled:true,version:'stable'}],revision:2,migrationVersion:1})),preferences:['u','v'].map(_id=>({_id,multiAssetVersion:1}))});
 let user='u'; const main=createHandler({db,getOpenid:()=>user,resolve:async()=>{throw Error('annotation must not resolve metadata')},now:()=>12345});
 return {main,tables,user:value=>user=value,save:(note='',tags=[],revision=2,assetId='gold-au9999')=>main({action:'saveAnnotation',assetId,note,tags,revision})};
}
test('annotation normalizes Unicode text and tags while preserving rules and order',async()=>{
 const f=setup(),before=await f.main(); assert.deepEqual(before.annotations,{});
 const r=await f.save('  观察😀  ',[' 长期 ','长期','低估']);assert.equal(r.ok,true,r.hint);
 assert.deepEqual(r.annotations,{'gold-au9999':{note:'观察😀',tags:['长期','低估'],updatedAt:12345}});
 assert.deepEqual(r.rules,before.rules);assert.deepEqual(r.items,before.items);assert.equal(r.revision,3);
 assert.deepEqual((await f.main()).annotations,r.annotations);assert.equal(f.tables.instruments,undefined);
 f.user('v');assert.deepEqual((await f.main()).annotations,{});
});
test('annotation length counts Unicode code points and enforces strict input types',async()=>{
 for(const [note,tags,revision] of [[null,[],2],[3,[],2],['',null,2],['',{},2],['',[3],2],['a'.repeat(121),[],2],['',['长'.repeat(9)],2],['',['a','b','c','d'],2],['',[],'2'],['',[],-1],['',[],1.2]]){
  const f=setup(),r=await f.save(note,tags,revision);assert.equal(r.ok,false,JSON.stringify([note,tags,revision]));assert.equal(r.err,'bad-annotation');assert.equal(f.tables.portfolios[0].revision,2);
 }
 const f=setup(),r=await f.save('😀'.repeat(120),['😀'.repeat(8)]);assert.equal(r.ok,true,r.hint);
});
test('annotations require a watched asset and reject stale revisions transactionally',async()=>{
 const f=setup();assert.equal((await f.save('a',[],2,'gold-invalid')).err,'bad-asset');
 assert.equal((await f.save('a',[],2,'sh600519')).err,'not-watched');
 const results=await Promise.all([f.save('first'),f.save('second')]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>!r.ok).err,'revision-conflict');
 assert.equal((await f.save('stale')).err,'revision-conflict');
 const saved=results.find(r=>r.ok);assert.deepEqual((await f.main()).annotations,saved.annotations);
});
test('clearing annotations deletes entries and removal cleans corresponding notes',async()=>{
 const f=setup();let r=await f.save('test',['tag']);r=await f.save('  ',['  '],r.revision);assert.equal(r.ok,true,r.hint);assert.deepEqual(r.annotations,{});
 r=await f.save('again',[],r.revision);r=await f.main({action:'remove',assetId:'gold-au9999'});assert.equal(r.ok,true);assert.deepEqual(r.annotations,{});assert.equal(r.rules.length,0);
});
test('client forwards annotations and supplies an empty map for old offline cache',async()=>{
 const {createClient}=require('../utils/portfolio-client');let called;
 const client=createClient({cloud:{callFunction:async value=>{called=value;return {result:{ok:true,items:[],rules:[],annotations:{},revision:3}}}},setStorageSync(){},getStorageSync(){}});
 await client.saveAnnotation('gold-au9999','note',['tag'],2);assert.deepEqual(called.data,{action:'saveAnnotation',assetId:'gold-au9999',note:'note',tags:['tag'],revision:2});
 const offline=createClient({getStorageSync:()=>({items:[],rules:[],revision:1})});assert.deepEqual((await offline.list()).annotations,{});assert.deepEqual(offline.getCached().annotations,{});
});
test('annotation revision also coordinates sorting and annotations never rotate reminder versions',async()=>{
 const f=setup();let r=await f.save('a');assert.equal((await f.main({action:'reorder',assetIds:['gold-xauusd','gold-au9999'],revision:2})).err,'revision-conflict');
 r=await f.main({action:'reorder',assetIds:['gold-xauusd','gold-au9999'],revision:r.revision});assert.equal(r.ok,true,r.hint);assert.equal(r.rules[0].version,'stable');assert.equal(r.annotations['gold-au9999'].note,'a');
 const stable=await f.save('a',[],r.revision);assert.equal(stable.revision,r.revision);assert.deepEqual(stable.rules,r.rules);
});
