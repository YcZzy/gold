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

test('active filter count includes zero bounds and resets without leaving the selected group',()=>{
 const {page,stored}=pageHarness('pages/index/index.js');
 page.onLoad();
 page.applyState({items:[],groups:[{id:'g',name:'长期观察',assetIds:[]}],rules:[],limits:{watchlist:5},revision:1});
 page.chooseGroup({currentTarget:{dataset:{id:'g'}}});
 page.setMarket({detail:{value:1}});
 page.setCondition({currentTarget:{dataset:{key:'minPct'}},detail:{value:'0'}});
 page.setCondition({currentTarget:{dataset:{key:'query'}},detail:{value:'  '}});
 assert.equal(page.data.filterCount,2);
 assert.equal(page.data.groupName,'长期观察');
 page.resetConditions();
 assert.equal(page.data.filterCount,0);
 assert.equal(page.data.view.groupId,'g');
 assert.equal(stored.get('watchlist-view-v1').minPct,'');
});

test('negative filter values can be typed naturally and invalid ranges show an inline explanation',()=>{
 const {page}=pageHarness('pages/index/index.js');page.onLoad();
 page.applyState({items:[],groups:[],rules:[],limits:{watchlist:5},revision:1});
 const enter=(key,value)=>page.setCondition({currentTarget:{dataset:{key}},detail:{value}});
 enter('minPct','-');
 assert.equal(page.data.view.minPct,'-');
 assert.equal(page.data.filterCount,0);
 assert.equal(page.data.errorText,'');
 enter('minPct','-2.5');enter('maxPct','-5');
 assert.match(page.data.filterError,/最低涨跌幅不能高于最高涨跌幅/);
 enter('maxPct','0');assert.equal(page.data.filterError,'');
 enter('minPrice','20');enter('maxPrice','10');
 assert.match(page.data.filterError,/最低价格不能高于最高价格/);
 page.resetConditions();assert.equal(page.data.filterError,'');
});

test('returning from an empty group to all keeps filters and exposes the matching rows',()=>{
 const {page}=pageHarness('pages/index/index.js');page.onLoad();
 page.applyState({items:[{id:'a',name:'甲',market:'SH',kind:'stock'}],groups:[{id:'empty',name:'空分组',assetIds:[]}],rules:[],limits:{watchlist:5},revision:1});
 page.setMarket({detail:{value:1}});
 page.chooseGroup({currentTarget:{dataset:{id:'empty'}}});
 assert.equal(page.data.visibleRows.length,0);
 page.chooseGroup({currentTarget:{dataset:{id:''}}});
 assert.equal(page.data.groupName,'全部自选');
 assert.equal(page.data.filterCount,1);
 assert.equal(page.data.visibleRows.length,1);
});
