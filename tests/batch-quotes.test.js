const{test}=require('node:test');const assert=require('node:assert/strict');const{batchQuotes}=require('../cloudfunctions/marketData/batch-quotes');
test('500 unique stocks use one service operation with at most three concurrent 30-stock provider batches',async()=>{let active=0,peak=0,calls=0;const ids=Array.from({length:500},(_,i)=>'sh'+(600000+i));const r=await batchQuotes(ids,async batch=>{assert.ok(batch.length<=30);calls++;peak=Math.max(peak,++active);await new Promise(r=>setTimeout(r,1));active--;return{ok:true,assets:batch.map(id=>({id})),quotes:batch.map(assetId=>({assetId,price:1})),errors:[]};});assert.equal(calls,17);assert.ok(peak<=3);assert.equal(r.quotes.length,500);});
test('batch rejects overflow and deduplicates; individual batch failures preserve other results',async()=>{await assert.rejects(batchQuotes(Array(2501).fill('x'),async()=>{}),/2500/);const r=await batchQuotes(['a','a','b'],async ids=>({ok:true,assets:ids.map(id=>({id})),quotes:[],errors:[]}));assert.equal(r.assets.length,2);});
test('provider batch failure does not lose successful other batches',async()=>{const ids=Array.from({length:65},(_,i)=>String(i));const r=await batchQuotes(ids,async batch=>{if(batch.includes('30'))throw Error('provider down');return{ok:true,assets:batch.map(id=>({id})),quotes:batch.map(assetId=>({assetId})),errors:[]};});assert.equal(r.quotes.length,35);assert.equal(r.errors.length,30);});

test('2500 stocks fit one service operation with at most ten concurrent batches and preserve partial failures', async () => {
  const ids = Array.from({length:2500}, (_, i) => 'sh' + (600000+i));
  let active = 0, peak = 0, calls = 0;
  const result = await batchQuotes(ids, async batch => {
    assert.ok(batch.length <= 30);
    calls++;
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, 1));
    active--;
    if (batch.includes(ids[2499])) throw Error('last provider batch failed');
    return {ok:true, assets:batch.map(id => ({id})), quotes:batch.map(assetId => ({assetId})), errors:[]};
  });
  assert.equal(calls, 84);
  assert.ok(peak > 3 && peak <= 10, 'larger scans need bounded extra parallelism');
  assert.equal(result.quotes.length, 2490);
  assert.deepEqual(result.errors.map(e => e.assetId), ids.slice(2490));
  assert.equal(new Set([...result.quotes.map(q => q.assetId), ...result.errors.map(e => e.assetId)]).size, 2500);
});
