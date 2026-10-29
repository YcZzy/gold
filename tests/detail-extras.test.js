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
