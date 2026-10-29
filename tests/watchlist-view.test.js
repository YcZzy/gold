const test=require('node:test'), assert=require('node:assert/strict');
const view=require('../utils/watchlist-view');
const display=require('../utils/display-preferences');
test('group sort is independent, missing quotes are last and source rows remain unchanged',()=>{
  const rows=[{id:'a',price:2,kind:'stock',market:'SH'},{id:'b',price:null,kind:'etf',market:'SZ'},{id:'c',price:3,kind:'stock',market:'SH'}];
  const groups=[{id:'g',assetIds:['c','b','a'],sortBy:'price',sortDirection:'desc'}];
  assert.deepEqual(view.select(rows,groups,{groupId:'g'}).map(r=>r.id),['c','a','b']);
  assert.deepEqual(view.select(rows,groups,{groupId:'g',kind:'etf'}).map(r=>r.id),['b']);
  assert.deepEqual(view.select(rows,groups,{minPrice:'2.5'}).map(r=>r.id),['c']);
  assert.deepEqual(rows.map(r=>r.id),['a','b','c']);
});
test('display preferences validate known toggles, persist and quiet charts have neutral up/down colors',()=>{
  const storage=new Map();const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v)};
  assert.equal(display.get(wx).quiet,false);
  display.save({quiet:true,showTime:false},wx);
  assert.equal(display.get(wx).quiet,true); assert.equal(display.get(wx).showTime,false);
  assert.throws(()=>display.save({quiet:'yes'},wx));
  assert.equal(display.colors({},display.get(wx)).up,display.colors({},display.get(wx)).down);
});
