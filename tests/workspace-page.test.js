const test=require('node:test'),assert=require('node:assert/strict');
const {pageHarness}=require('./helpers/page-harness');
test('watchlist group/market filters preserve master rows and management mode exposes the master order',()=>{
  const {page}=pageHarness('pages/index/index.js',{'market-client':{},'portfolio-client':{}});
  page.onLoad();page.applyState({items:[{id:'a',name:'甲',market:'SH',kind:'stock'},{id:'b',name:'乙',market:'US',kind:'etf'}],
    groups:[{id:'g',name:'组',assetIds:['b'],sortBy:'manual',sortDirection:'asc'}],rules:[],limits:{watchlist:5},revision:1});
  page.chooseGroup({currentTarget:{dataset:{id:'g'}}});
  assert.equal(page.data.visibleRows.length,1);assert.equal(page.data.visibleRows[0].id,'b');
  assert.equal(page.data.rows.length,2);page.toggleManage();assert.equal(page.data.visibleRows.length,2);
});
test('hidden watchlist ignores late sort responses and re-reads server state when returning',async()=>{
 let finish;const {page}=pageHarness('pages/index/index.js',{'market-client':{},'portfolio-client':{saveGroup:()=>new Promise(r=>finish=r)}});
 page.onLoad();page._visible=true;const s={items:[],groups:[{id:'g',name:'甲',assetIds:[],sortBy:'manual',sortDirection:'asc'}],rules:[],limits:{watchlist:5},revision:1};
 page.applyState(s);page.chooseGroup({currentTarget:{dataset:{id:'g'}}});
 const pending=page.changeSort({detail:{value:1}});page.onHide();finish({...s,revision:2});await pending;
 assert.equal(page.data.revision,1);
});
