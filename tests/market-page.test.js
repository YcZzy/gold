const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
function fixture(overrides={}){
 let page;const calls=[],storage=new Map(),routes=[];
 const d={indices:async()=>({items:[{id:'index:sh000001',name:'上证指数',price:3600,changePct:1,sourceLabel:'2026-10-29 10:00',market:'SH'}],fetchedAt:100,source:'tencent'}),ranking:async(sort,page)=>{calls.push([sort,page]);return {items:[{assetId:'sh600519',asset:{id:'sh600519',name:'贵州茅台',precision:2},price:100,changePct:1,amount:1200}],page,hasMore:true,fetchedAt:100,sourceTime:null,source:'sina'}},sectors:async()=>({items:[{id:'sina:industry:new_fjzz',name:'飞机制造',count:14,changePct:2}],page:1,hasMore:false,source:'sina',fetchedAt:100}),members:async()=>({items:[],page:1,hasMore:false,fetchedAt:100}),flowRanking:async()=>({items:[],page:1,hasMore:false,fetchedAt:100}),...overrides.discovery};
 const portfolio={list:async()=>({items:[]}),add:async id=>({items:[{id}]}),...overrides.portfolio};
 const wx={getStorageSync:k=>storage.get(k),setStorageSync:(k,v)=>storage.set(k,v),navigateTo:r=>routes.push(r.url),stopPullDownRefresh(){}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../pages/market/market.js'),'utf8'),{Page:p=>page=p,wx,console,require:p=>p.includes('discovery-client')?d:p.includes('portfolio-client')?portfolio:p.includes('display-preferences')?{get:()=>({quiet:true})}:p.includes('theme')?{getTheme:()=> 'blackgold',applyChrome(){}}:require('../utils/asset-format')});
 page.data=JSON.parse(JSON.stringify(page.data));page.setData=p=>Object.assign(page.data,p);
 return {page,wx,storage,routes,calls};
}
test('market opens independent indices and ranking with current theme and explicit fetch time',async()=>{
 const {page}=fixture();page.onLoad();await page.onShow();assert.equal(page.data.theme,'blackgold');assert.equal(page.data.quiet,true);
 assert.equal(page.data.indices.length,5);assert.equal(page.data.rows.length,1);assert.match(page.data.listTime,/获取时间/);assert.equal(page.data.listLoading,false);
});
test('index choices persist per device without creating tradable watchlist assets',async()=>{
 const {page,storage}=fixture();page.onLoad();page.toggleIndexEditor();page.onIndexChoice({detail:{value:['index:us.INX','bogus']}});page.saveIndexChoices();
 assert.deepEqual([...storage.get('discovery-indices-v1')],['index:us.INX']);assert.equal(page.data.indexEditing,false);
});
test('sector search, members, list sorting and pagination call complete endpoints',async()=>{
 const queries=[];const {page}=fixture({discovery:{sectors:async q=>{queries.push(q);return {items:[{id:'sina:industry:new_fjzz',name:'飞机制造'}],page:1,hasMore:false,fetchedAt:100}},members:async(id,p)=>{queries.push({id,...p});return {items:[],page:1,hasMore:false,fetchedAt:100}}}});
 page.onLoad();await page.onShow();await page.switchSection({currentTarget:{dataset:{value:'industry'}}});
 page.onKeywordInput({detail:{value:'飞机'}});await page.searchSectors();assert.equal(queries.at(-1).keyword,'飞机');
 await page.openSector({currentTarget:{dataset:{id:'sina:industry:new_fjzz',name:'飞机制造'}}});assert.equal(queries.at(-1).id,'sina:industry:new_fjzz');
 assert.equal(page.data.rows.length,0);await page.closeSector();assert.equal(page.data.selectedSector,null);
 await page.switchSection({currentTarget:{dataset:{value:'ranking'}}});await page.nextPage();assert.equal(page.data.listPage,2);
});
test('listing an error keeps the previous snapshot and retry restores it',async()=>{
 let fail=false;const {page}=fixture({discovery:{ranking:async()=>{if(fail)throw Error('数据不可用');return {items:[{assetId:'sh600519',asset:{id:'sh600519',name:'贵州茅台'},price:100}],page:1,fetchedAt:100}}}});
 page.onLoad();await page.onShow();fail=true;await page.loadList();assert.match(page.data.listError,/数据不可用/);assert.equal(page.data.rows.length,1);
 fail=false;await page.loadList();assert.equal(page.data.listError,'');
});
test('rows navigate to existing detail and adding enforces server watchlist errors inline',async()=>{
 const {page,routes}=fixture({portfolio:{add:async()=>{throw Error('自选额度已满')}}});page.onLoad();await page.onShow();
 page.openAsset({currentTarget:{dataset:{id:'sh600519'}}});assert.equal(routes[0],'/pages/detail/detail?assetId=sh600519');
 await page.addAsset({currentTarget:{dataset:{id:'sh600519'}}});assert.equal(page.data.rowErrorId,'sh600519');assert.match(page.data.rowError,/额度已满/);
 assert.equal(page.data.rowBusy,'');
});
test('late results cannot replace another section or write after page hide',async()=>{
 let finish;const {page}=fixture({discovery:{ranking:()=>new Promise(r=>{finish=r})}});page.onLoad();page._visible=true;
 const old=page.loadList();await page.switchSection({currentTarget:{dataset:{value:'industry'}}});finish({items:[{assetId:'sh600519'}],fetchedAt:100});await old;
 assert.equal(page.data.rows[0].id,'sina:industry:new_fjzz');
 page.onHide();assert.equal(page._visible,false);
});
test('market template exposes labels, independent retries, empty and pagination states',()=>{
 const s=fs.readFileSync(require.resolve('../pages/market/market.wxml'),'utf8');
 for(const token of ['label','aria-label','loadIndices','loadList','rows.length','nextPage','quiet-mode','selectedSector','saveIndexChoices'])assert.ok(s.includes(token),token);
});

test('pending add and snapshot requests cannot update a hidden or reentered market page',async()=>{
 let finish;const {page}=fixture({portfolio:{add:()=>new Promise(r=>{finish=r})}});page.onLoad();await page.onShow();
 const adding=page.addAsset({currentTarget:{dataset:{id:'sh600519'}}});page.onHide();
 const patches=[];const apply=page.setData;page.setData=p=>{patches.push(p);apply(p)};
 finish({items:[{id:'sh600519'}]});await adding;assert.equal(patches.length,0);
});
test('a partial index response visibly identifies a chosen unavailable index',async()=>{
 const {page}=fixture();page.onLoad();await page.onShow();
 assert.equal(page.data.indices.length,5);assert.equal(page.data.indices.find(i=>i.id==='index:sz399001').statusText,'暂不可用');
});

test('changing section immediately removes incompatible rows and updates presentation while pending',async()=>{
 let finish;const {page}=fixture({discovery:{sectors:()=>new Promise(r=>{finish=r})}});
 page.onLoad();await page.onShow();const pending=page.switchSection({currentTarget:{dataset:{value:'industry'}}});
 assert.equal(page.data.rows.length,0);assert.equal(page.data.isSector,true);assert.equal(page.data.isFlow,false);
 assert.equal(page.data.listTime,'');assert.match(page.data.listTitle,/行业/);
 finish({items:[],page:1,fetchedAt:100});await pending;
});
test('failed new query never shows the preceding query snapshot',async()=>{
 const {page}=fixture({discovery:{sectors:async()=>{throw Error('板块不可用')}}});
 page.onLoad();await page.onShow();await page.switchSection({currentTarget:{dataset:{value:'concept'}}});
 assert.equal(page.data.rows.length,0);assert.equal(page.data.hasMore,false);assert.equal(page.data.listTime,'');
 assert.doesNotMatch(page.data.listError,/保留上次列表/);
});
test('sector search submits trimmed text and draft typing does not change refresh query; clear restores all sectors',async()=>{
 const queries=[];const {page}=fixture({discovery:{sectors:async q=>{queries.push(q);return {items:[],page:q.page,fetchedAt:100}}}});
 page.onLoad();await page.onShow();await page.switchSection({currentTarget:{dataset:{value:'industry'}}});
 page.onKeywordInput({detail:{value:' 飞机 '}});await page.searchSectors();assert.equal(queries.at(-1).keyword,'飞机');
 page.onKeywordInput({detail:{value:'银行'}});await page.loadList();assert.equal(queries.at(-1).keyword,'飞机');
 await page.clearSearch();assert.equal(queries.at(-1).keyword,'');assert.equal(page.data.keyword,'');assert.equal(page.data.page,1);
});
test('tenth page stops pagination and rows carry absolute rank numbers',async()=>{
 const {page,calls}=fixture();page.onLoad();await page.onShow();page.setData({page:10});await page.loadList();
 assert.equal(page.data.hasMore,false);assert.equal(page.data.rows[0].rank,181);
 const count=calls.length;await page.nextPage();assert.equal(calls.length,count);
});

test('reaching the bottom keeps the current page until the next-page action is tapped',async()=>{
 const {page,calls}=fixture();page.onLoad();await page.onShow();
 const count=calls.length;
 if(typeof page.onReachBottom==='function')await page.onReachBottom();
 assert.equal(calls.length,count);assert.equal(page.data.listPage,1);
 await page.nextPage();assert.equal(calls.length,count+1);assert.equal(page.data.listPage,2);
});
