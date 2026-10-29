const {test}=require('node:test');
const assert=require('node:assert/strict');
let engine;try{engine=require('../cloudfunctions/ledger/engine');}catch(_){}
const asset={id:'sh600519',name:'股票',code:'600519',market:'SH',kind:'stock',currency:'CNY',unit:'元/股',precision:2,timezone:'Asia/Shanghai',secid:'1.600519',quoteCode:'sh600519'};
const assets={[asset.id]:asset};
const raw=(type,x={})=>({type,date:'2026-10-28',currency:'CNY',assetId:asset.id,...x});
function entries(rows){return rows.map((r,i)=>engine.normalizeEntry(r,{id:'r'+i,logicalId:'l'+i,version:1,sequence:i+1},assets,Date.parse('2026-10-30')));}
const seed=[raw('openingCash',{amount:'3000',assetId:''}),raw('openingPosition',{quantity:'100',cost:'800'})];
test('ledger engine implements weighted costs, fees, cash and trading-day cash-flow PnL',()=>{
 assert.ok(engine,'ledger engine must exist');
 const rows=entries([...seed,raw('buy',{date:'2026-10-29',quantity:'50',price:'12',fee:'5'}),raw('sell',{date:'2026-10-29',quantity:'60',price:'13',fee:'6'})]);
 const r=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29',sourceTime:Date.parse('2026-10-29T06:00Z')}]);
 const p=r.positions[0];assert.equal(p.quantity,90);assert.equal(p.cost,843);assert.equal(p.realized,212);assert.equal(p.unrealized,147);assert.equal(p.daily,159);assert.equal(p.totalPnl,359);assert.equal(r.currencies[0].cash,3169);assert.equal(r.currencies[0].equity,4159);
});
test('same-day buy/sell and complete sale retain correct day gain',()=>{
 const initial=raw('openingCash',{amount:'5000',assetId:''});
 let rows=entries([initial,raw('buy',{date:'2026-10-29',quantity:100,price:10,fee:5}),raw('sell',{date:'2026-10-29',quantity:40,price:12,fee:3})]);
 let p=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29'}]).positions[0];assert.equal(p.daily,132);assert.equal(p.realized,75);assert.equal(p.unrealized,57);
 rows=entries([...seed,raw('sell',{date:'2026-10-29',quantity:100,price:12,fee:5})]);p=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:12,prevClose:10,sessionDate:'2026-10-29'}]).positions[0];assert.equal(p.quantity,0);assert.equal(p.cost,0);assert.equal(p.realized,395);assert.equal(p.daily,195);
});
test('replay validates every intermediate cash and quantity and supports edit/void versions',()=>{
 const rows=entries([...seed,raw('sell',{quantity:50,price:10})]);
 assert.throws(()=>engine.replay([...rows,{...rows[1],id:'correction',version:2,voided:true}],assets),/卖出|持仓/);
 assert.throws(()=>engine.replay(entries([raw('buy',{quantity:1,price:10})]),assets),/现金/);
 assert.throws(()=>engine.replay(entries([...seed,raw('sell',{quantity:101,price:10})]),assets),/卖出|持仓/);
 const edit={...rows[1],id:'edit',version:2,cost:'900'};assert.equal(engine.replay([...rows,edit],assets).positions[0].cost,450);
});
test('partial valuation and currencies never fabricate complete assets or gold daily PnL',()=>{
 const gold={...asset,id:'gold-au9999',kind:'gold',market:'SGE',unit:'元/克'};const aa={...assets,[gold.id]:gold};
 const rows=[...entries(seed),engine.normalizeEntry(raw('openingPosition',{assetId:gold.id,quantity:'0.125',cost:'100'}),{id:'g',logicalId:'g',version:1,sequence:4},aa,Date.parse('2026-10-30'))];
 const r=engine.evaluate(rows,aa,{},[{assetId:gold.id,price:900,prevClose:899,sessionDate:'2026-10-29'}]);assert.equal(r.currencies[0].complete,false);assert.equal(r.currencies[0].equity,null);assert.equal(r.positions.find(x=>x.assetId===gold.id).daily,null);assert.equal(r.positions.find(x=>x.assetId===asset.id).unrealized,null);
});
test('cash income is separate from cost, deposits are not profit, and initial day has no fake gain',()=>{
 const rows=entries([...seed,raw('income',{date:'2026-10-29',amount:20}),raw('deposit',{date:'2026-10-29',assetId:'',amount:100})]);const r=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:9.8,prevClose:10,sessionDate:'2026-10-29'}]);assert.equal(r.positions[0].daily,0);assert.equal(r.positions[0].cost,800);assert.equal(r.currencies[0].cash,3120);
 assert.equal(engine.evaluate(entries(seed),assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-28'}]).positions[0].daily,null);
});
test('decimal validation rejects nonfinite, negatives, future dates and excess precision',()=>{
 for(const x of [{quantity:'1e3'},{quantity:'NaN'},{quantity:'-1'},{quantity:'0.0000001'},{date:'2026-02-30'},{date:'2026-11-01'},{currency:'USD'}])assert.throws(()=>entries([raw('openingPosition',{quantity:'1',cost:'10',...x})]));
 const r=engine.replay(entries([raw('openingCash',{assetId:'',amount:'0.3'}),raw('buy',{quantity:'1',price:'0.1'}),raw('buy',{quantity:'1',price:'0.2'}),raw('sell',{quantity:'2',price:'0.15'})]),assets);assert.equal(r.currencies[0].cash,0.3);assert.equal(r.positions[0].cost,0);assert.equal(r.positions[0].realized,0);
});
test('cleared positions retain known zero market value without a live quote',()=>{const rows=entries([...seed,raw('sell',{quantity:100,price:12,fee:5})]);const r=engine.evaluate(rows,assets,{},[]);assert.equal(r.positions[0].marketValue,0);assert.equal(r.positions[0].unrealized,0);assert.equal(r.positions[0].totalPnl,395);assert.equal(r.positions[0].daily,null);});
test('mixed currencies retain independent cash and US data keep quote session dates across Shanghai midnight',()=>{const usd={...asset,id:'usAAPL',market:'US',currency:'USD',timezone:'America/New_York'},aa={...assets,[usd.id]:usd};const input=[...seed,{type:'openingPosition',assetId:usd.id,currency:'USD',date:'2026-10-28',quantity:10,cost:100}];const rows=input.map((e,i)=>engine.normalizeEntry(e,{id:'x'+i,logicalId:'x'+i,version:1,sequence:i+1},aa,Date.parse('2026-10-30')));const r=engine.evaluate(rows,aa,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29'},{assetId:usd.id,price:11,prevClose:10,sessionDate:'2026-10-28'}]);assert.deepEqual(r.currencies.map(c=>c.currency).sort(),['CNY','USD']);assert.equal(r.positions.find(p=>p.assetId===usd.id).daily,null);assert.equal(r.positions.find(p=>p.assetId===usd.id).sessionDate,'2026-10-28');});
test('split and dividend operations preserve cost without fabricated day comparison',()=>{const rows=entries([...seed,raw('split',{date:'2026-10-29',numerator:2,denominator:1})]);const r=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:5,prevClose:10,sessionDate:'2026-10-29'}]);assert.equal(r.positions[0].quantity,200);assert.equal(r.positions[0].cost,800);assert.equal(r.positions[0].unrealized,200);assert.equal(r.positions[0].daily,null);});
test('unsafe sequence identities cannot poison subsequent additions',()=>{const good=entries(seed);assert.throws(()=>engine.effective([{...good[0],sequence:1e20}]),/顺序/);});
test('currency summary exposes cost-based rates with documented denominators',()=>{const rows=entries([...seed,raw('buy',{date:'2026-10-29',quantity:50,price:12,fee:5}),raw('sell',{date:'2026-10-29',quantity:60,price:13,fee:6})]);const c=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29'}]).currencies[0];assert.equal(c.unrealizedRate,147/843*100);assert.equal(c.totalPnlRate,359/1405*100);});
test('trade normalization retains gross source and recomputes automatic amount after price change',()=>{const old=entries([raw('buy',{quantity:100,price:10})])[0];assert.equal(old.grossAmountMode,'auto');const updated=engine.normalizeEntry({...old,price:20},{...old,id:'updated',version:2},assets,Date.parse('2026-10-30'));assert.equal(updated.grossAmount,'2000');const explicit=entries([raw('buy',{quantity:100,price:10,grossAmount:'1001'})])[0];assert.equal(explicit.grossAmountMode,'explicit');});
test('realized return uses transferred sale cost and is unknown before a sale',()=>{let rows=entries(seed);assert.equal(engine.replay(rows,assets).positions[0].realizedRate,null);rows=entries([...seed,raw('sell',{quantity:50,price:12,fee:5})]);const p=engine.replay(rows,assets).positions[0];assert.equal(p.realizedCost,400);assert.equal(p.realizedRate,195/400*100);});
test('daily currency grouping includes independent fee once and excludes external deposits',()=>{const rows=entries([...seed,raw('expense',{assetId:'',date:'2026-10-29',amount:10}),raw('deposit',{assetId:'',date:'2026-10-29',amount:500})]);const c=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29'}]).currencies[0];assert.equal(c.totalPnl,290);assert.equal(c.dailyGroups[0].value,90);assert.equal(c.dailyGroups[0].complete,true);});
test('independent cash expense cannot masquerade as complete account daily profit without that session baseline',()=>{const rows=entries([...seed,raw('expense',{assetId:'',date:'2026-10-29',amount:10})]);const c=engine.evaluate(rows,assets,{},[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-28'}]).currencies[0];const day=c.dailyGroups.find(g=>g.date==='2026-10-29');assert.ok(day);assert.equal(day.complete,false);assert.equal(day.value,null);assert.equal(day.knownCashFlow,-10);});
