const {test}=require('node:test'),assert=require('node:assert/strict');
const {inspectDraft}=require('../utils/holdings-form');
const trade={type:'buy',assetId:'a',date:'2026-10-30',quantity:'3',price:'10.25',fee:'0.10',grossAmount:''};
test('trade preview includes fees in buy total and sell net income',()=>{
 assert.equal(inspectDraft(trade).preview.cashText,'30.85');
 assert.equal(inspectDraft({...trade,type:'sell'}).preview.cashText,'30.65');
 assert.equal(inspectDraft({...trade,grossAmount:'31'}).preview.grossText,'31.00');
});
test('invalid decimals and missing fields cannot produce misleading previews',()=>{
 for(const quantity of ['','-1','0','1.1234567','1e3']){const r=inspectDraft({...trade,quantity});assert.ok(r.errors.quantity);assert.equal(r.preview,null);}
 assert.ok(inspectDraft({...trade,assetId:''}).errors.assetId);
 assert.ok(inspectDraft({...trade,date:'2026-02-30'}).errors.date);
 assert.equal(inspectDraft({...trade,quantity:'0.000001'}).errors.quantity,undefined);
});
test('opening positions never imply cash movement and opening cash sets balance',()=>{
 assert.equal(inspectDraft({...trade,type:'openingPosition',cost:'100'}).preview.cashText,'不影响现金');
 assert.equal(inspectDraft({...trade,type:'openingCash',amount:'0'}).preview.cashLabel,'期初现金余额');
 assert.ok(inspectDraft({...trade,type:'deposit',amount:'0'}).errors.amount);
});
test('oversized input is rejected before generating a cash preview',()=>{
 assert.ok(inspectDraft({...trade,quantity:'1000000000001'}).errors.quantity);
 assert.ok(inspectDraft({...trade,type:'deposit',amount:'1000000000001'}).errors.amount);
});

test('trade preview describes trade totals rather than a required account debit',()=>{
 const buy=inspectDraft(trade).preview,sell=inspectDraft({...trade,type:'sell'}).preview;
 assert.equal(buy.cashLabel,'买入合计（含费用）');assert.equal(buy.cashText,'30.85');assert.equal(sell.cashLabel,'卖出净收入');assert.equal(sell.cashText,'30.65');
});
