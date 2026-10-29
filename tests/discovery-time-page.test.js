const test=require('node:test'),assert=require('node:assert/strict');
const{pageHarness}=require('./helpers/page-harness');
test('flow rankings expose source dates separately from retrieval time',async()=>{
 const sourceTime=Date.parse('2026-10-28T07:00Z');
 const{page}=pageHarness('pages/market/market.js',{'discovery-client':{flowRanking:async()=>({items:[{assetId:'sh600519',sourceTime,flow:{main:100}}],source:'eastmoney',sourceTime,fetchedAt:Date.now(),page:1})}});
 page.onLoad();page._visible=true;page.data.section='flowRanking';await page.loadList();
 assert.match(page.data.listTime,/行情来源/);assert.match(page.data.rows[0].sourceTimeText,/10-28/);
});
