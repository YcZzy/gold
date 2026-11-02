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
test('removed device preferences ignore old overrides and preserve standard chart colors',()=>{
  let reads=0,writes=0;
  const wx={getStorageSync:()=>{reads++;return {quiet:true,compact:true,hideAmounts:true,showChange:false,showTime:false,showNotes:false};},setStorageSync:()=>{writes++;}};
  assert.deepEqual(display.get(wx),{quiet:false,compact:false,hideAmounts:false,showChange:true,showTime:true,showNotes:true});
  const colors={up:'#ff0000',down:'#00ff00'};assert.deepEqual(display.colors(colors,{quiet:true}),colors);
  assert.equal(reads,0);assert.equal(writes,0);assert.equal(display.save,undefined);
  const first=display.get();first.quiet=true;assert.equal(display.get().quiet,false);
});
