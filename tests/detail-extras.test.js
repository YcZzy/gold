const test=require('node:test'),assert=require('node:assert/strict');
const {pageHarness}=require('./helpers/page-harness');
const asset={id:'sh600519',name:'贵州茅台',market:'SH',kind:'stock',precision:2};
test('detail requests explicit depth or flow and distinguishes zero, negative and absent values',async()=>{
 const calls=[];const{page}=pageHarness('pages/detail/detail.js',{'discovery-client':{
  orderbook:async id=>{calls.push(id);return{bids:[{price:10,volume:0}],asks:[{price:null,volume:null}],source:'tencent',sourceTime:Date.now()};},
  flow:async()=>({flow:{main:-120000,mainPct:-2,large:0,largePct:0},source:'eastmoney',sourceTime:Date.now()}),
 }});
 page.onLoad({assetId:asset.id});page._visible=true;page.data.asset=asset;
 await page.chooseExtra({currentTarget:{dataset:{mode:'orderbook'}}});
 assert.deepEqual(calls,[asset.id]);assert.equal(page.data.bookRows[0].bidVolume,'0');assert.equal(page.data.bookRows[0].askPrice,'--');
 await page.chooseExtra({currentTarget:{dataset:{mode:'flow'}}});
 assert.match(page.data.flowRows[0].amount,/-12.00/);assert.equal(page.data.flowRows[2].amount,'0.00 元');
});
test('late extra responses cannot write into a hidden detail page',async()=>{
 let finish;const{page}=pageHarness('pages/detail/detail.js',{'discovery-client':{flow:()=>new Promise(r=>finish=r)}});
 page.onLoad({assetId:asset.id});page._visible=true;page.data.asset=asset;
 const pending=page.chooseExtra({currentTarget:{dataset:{mode:'flow'}}});page.onHide();
 finish({flow:{main:100},source:'eastmoney',sourceTime:Date.now()});await pending;
 assert.equal(page.data.flowRows.length,0);
});

test('chart tools and methodology disclosure toggle independently without resetting the chart viewport',()=>{
 const {page}=pageHarness('pages/detail/detail.js');page.onLoad({assetId:asset.id});
 page.viewport={offset:12,count:30};page.data.period='1y';
 assert.equal(page.data.chartToolsOpen,false);
 assert.equal(page.data.chartInfoOpen,false);
 page.toggleChartTools();assert.equal(page.data.chartToolsOpen,true);
 page.toggleChartInfo();assert.equal(page.data.chartInfoOpen,true);
 page.toggleChartTools();assert.equal(page.data.chartToolsOpen,false);
 assert.equal(page.data.chartInfoOpen,true);
 assert.deepEqual(page.viewport,{offset:12,count:30});
 assert.equal(page.data.period,'1y');
});

test('refresh feedback stays active until all detail sections finish and repeated taps do not duplicate work',async()=>{
 const {page}=pageHarness('pages/detail/detail.js');page.onLoad({assetId:asset.id});page._visible=true;
 let finish;let calls=0;
 page.loadQuote=()=>{calls++;return new Promise(resolve=>finish=resolve);};
 page.loadChart=async()=>{};page.loadIntl=async()=>{};page.loadExtra=async()=>{};
 const refresh=page.refreshMarket();
 assert.equal(page.data.refreshing,true);
 await page.refreshMarket();assert.equal(calls,1);
 finish();await refresh;
 assert.equal(page.data.refreshing,false);
});
