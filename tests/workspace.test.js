const test = require('node:test');
const assert = require('node:assert/strict');
const { createHandler } = require('../cloudfunctions/portfolio');
const { memoryDb } = require('./helpers/asset-db');
function setup() {
  const { db, tables } = memoryDb({ portfolios: [{ _id:'u',openid:'u',items:['gold-au9999'],rules:[],annotations:{},revision:0,migrationVersion:1 }], preferences:[{_id:'u',multiAssetVersion:1}] });
  const resolve = async id => ({id,name:id,code:id.slice(2),market:'SH',kind:'stock',currency:'CNY',unit:'元/股',precision:2,secid:'1.'+id.slice(2),quoteCode:id});
  return { tables, main:createHandler({db,getOpenid:()=> 'u',resolve,now:()=>1000}) };
}
test('groups preserve independent membership and sort without changing the master order', async()=>{
  const f=setup();
  let r=await f.main({action:'saveGroup',group:{name:'重点观察',assetIds:['gold-au9999'],sortBy:'changePct',sortDirection:'desc'},revision:0});
  assert.equal(r.ok,true,r.hint); assert.equal(r.groups[0].name,'重点观察'); assert.deepEqual(r.items.map(a=>a.id),['gold-au9999']);
  const group=r.groups[0];
  r=await f.main({action:'saveGroup',group:{...group,name:'长期配置',sortBy:'price'},revision:r.revision});
  assert.equal(r.ok,true,r.hint); assert.equal(r.groups[0].sortBy,'price');
  r=await f.main({action:'deleteGroup',groupId:group.id,revision:r.revision});
  assert.equal(r.ok,true,r.hint); assert.equal(r.groups.length,0); assert.equal(r.items.length,1);
});
test('group validations reject stale revisions, unknown members, duplicate names and excessive lengths',async()=>{
  const f=setup(); const group={name:'一',assetIds:['gold-au9999'],sortBy:'manual',sortDirection:'asc'};
  assert.equal((await f.main({action:'saveGroup',group,revision:0})).ok,true);
  for(const event of [
    {group:{...group,name:'二'},revision:0},
    {group,revision:1},
    {group:{...group,name:'二',assetIds:['sh600519']},revision:1},
    {group:{...group,name:'长'.repeat(17)},revision:1},
    {group:{...group,name:'二',sortBy:'__proto__'},revision:1},
  ]) assert.equal((await f.main({action:'saveGroup',...event})).ok,false);
});
test('batch import validates all securities and quotas before atomic additions',async()=>{
  const f=setup();
  const r=await f.main({action:'batchAdd',assetIds:['sh600519','sh600519','sh600418'],revision:0});
  assert.equal(r.ok,true,r.hint); assert.deepEqual(r.items.map(a=>a.id),['gold-au9999','sh600519','sh600418']);
  assert.equal((await f.main({action:'batchAdd',assetIds:['sh600001','sh600002','sh600003'],revision:r.revision})).ok,false);
  assert.equal(f.tables.portfolios[0].items.length,3);
});
test('backup import merges groups and notes while preserving existing notes unless explicitly requested',async()=>{
  const f=setup();
  let r=await f.main({action:'batchAdd',assetIds:['sh600519'],revision:0,entries:[{assetId:'sh600519',note:'观察量能',tags:['消费'],groups:['关注组']}],groupSettings:[{name:'关注组',sortBy:'amount',sortDirection:'desc'}]});
  assert.equal(r.ok,true,r.hint); assert.equal(r.annotations.sh600519.note,'观察量能');
  assert.deepEqual(r.groups[0].assetIds,['sh600519']);
  assert.equal(r.groups[0].sortBy,'amount');
  r=await f.main({action:'batchAdd',assetIds:['sh600519'],revision:r.revision,entries:[{assetId:'sh600519',note:'新笔记',tags:[],groups:['关注组']}]});
  assert.equal(r.annotations.sh600519.note,'观察量能');
  r=await f.main({action:'remove',assetId:'sh600519'});
  assert.equal(r.groups[0].assetIds.length,0); assert.equal(r.annotations.sh600519,undefined);
});
test('JSON group restore preserves member order and groups with no members',async()=>{
 const f=setup();
 const r=await f.main({action:'batchAdd',assetIds:['sh600519','sh600418'],revision:0,
  groupSettings:[{name:'手动组',assetIds:['sh600418','sh600519'],sortBy:'manual',sortDirection:'asc'},
   {name:'空组',assetIds:[],sortBy:'price',sortDirection:'desc'}]});
 assert.equal(r.ok,true,r.hint);assert.deepEqual(r.groups[0].assetIds,['sh600418','sh600519']);
 assert.equal(r.groups[1].name,'空组');assert.deepEqual(r.groups[1].assetIds,[]);
});
test('empty-group-only backups can be restored without adding securities',async()=>{
 const f=setup();const r=await f.main({action:'batchAdd',assetIds:[],revision:0,groupSettings:[{name:'计划观察',assetIds:[],sortBy:'manual',sortDirection:'asc'}]});
 assert.equal(r.ok,true,r.hint);assert.equal(r.groups[0].name,'计划观察');assert.equal(r.items.length,1);
});
