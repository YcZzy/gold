const{test}=require('node:test');const assert=require('node:assert/strict');const{createHandler}=require('../cloudfunctions/callBudget');const{memoryDb}=require('./helpers/asset-db');
const now=Date.parse('2026-11-02T00:00Z');
test('leases share a 200-unit monthly cap across devices and clearing storage; each lease counts its own invocation',async()=>{const{db,tables}=memoryDb({});const main=createHandler({db,getOpenid:()=> 'user',now:()=>now});let total=0;for(let i=0;i<2;i++){const r=await main();assert.equal(r.ok,true);assert.equal(r.credits,99);assert.equal(r.limit,200);total+=r.credits+1;}assert.equal(total,200);const r=await main();assert.equal(r.ok,false);assert.equal(r.err,'cloud-call-budget-exceeded');assert.equal(tables.cloudCallBudgets[0].allocated,200);});
test('budget requires identity, isolates users and follows Beijing month boundary',async()=>{const{db}=memoryDb({});assert.equal((await createHandler({db,getOpenid:()=>null,now:()=>now})()).ok,false);for(const user of ['a','b'])assert.equal((await createHandler({db,getOpenid:()=>user,now:()=>now})()).credits,99);assert.equal((await createHandler({db,getOpenid:()=> 'a',now:()=>Date.parse('2026-11-30T16:00Z')})()).month,'2026-12');});
test('concurrent device leases never allocate beyond 200 units',async()=>{const{db}=memoryDb({});const main=createHandler({db,getOpenid:()=> 'user',now:()=>now});const results=await Promise.all(Array.from({length:20},()=>main()));assert.equal(results.filter(r=>r.ok).length,2);assert.equal(results.filter(r=>!r.ok).length,18);});

test('legacy allocations above 200 remain exhausted without resetting the monthly ledger', async () => {
  for (const allocated of [201, 800]) {
    const {db, tables} = memoryDb({cloudCallBudgets:[{_id:'user:2026-11', month:'2026-11', allocated}]});
    const main = createHandler({db, getOpenid:() => 'user', now:() => now});
    for (let i = 0; i < 2; i++) {
      const result = await main();
      assert.equal(result.ok, false);
      assert.equal(result.err, 'cloud-call-budget-exceeded');
      assert.equal(tables.cloudCallBudgets[0].allocated, allocated);
    }
  }
});

test('500 accounts allocate at most 100000 units including successful lease invocations', async () => {
  const {db} = memoryDb({});
  let total = 0;
  for (let i = 0; i < 500; i++) {
    const main = createHandler({db, getOpenid:() => 'u' + i, now:() => now});
    for (let lease = 0; lease < 2; lease++) {
      const result = await main();
      assert.equal(result.ok, true);
      total += result.credits + 1;
    }
    assert.equal((await main()).err, 'cloud-call-budget-exceeded');
  }
  assert.equal(total, 100000);
  const timerCalls = 31 * 24 * 60;
  assert.equal(timerCalls * 2 + total, 189280);
  assert.ok(timerCalls * 2 + total < 200000);
});
