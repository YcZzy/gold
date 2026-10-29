const test=require('node:test');const assert=require('node:assert/strict');
const d=require('../cloudfunctions/marketData/discovery');
const samples=require('./fixtures/discovery/providers-2026-10-29.json').samples;
const now=Date.parse('2026-10-29T06:00:00Z');
const instruments=require('../cloudfunctions/marketData/instruments');
function service(overrides={}) {
 const cache=new Map(),requests=[];let clock=now;
 const request=async url=>{requests.push(url);if(url.includes('qt.gtimg'))return samples.tencent_indices.body;
 if(url.includes('newSinaHy'))return samples.sina_industries.body;if(url.includes('newFLJK'))return samples.sina_concepts.body;
 if(url.includes('ulist'))return samples.east_single_flow.body;if(url.includes('push2'))return samples.east_flow_list.body;
 if(url.includes('node=new_fjzz'))return samples.sina_members.body;if(url.includes('node=gn_hwqc'))return samples.sina_concept_members.body;
 return samples.sina_rank.body;};
 const api=d.createDiscovery({request,now:()=>clock,get:async(c,k)=>cache.get(c+':'+k),set:async(c,k,v)=>cache.set(c+':'+k,v),resolve:async id=>instruments.canonical(id),...overrides});
 return {api,cache,requests,advance:ms=>{clock+=ms}};
}
test('eight whitelisted indices retain separate identities and New York source time',()=>{
 const rows=d.parseIndices(samples.tencent_indices.body,now);assert.equal(rows.length,8);
 const us=rows.find(r=>r.code==='us.INX');assert.equal(us.sourceTime,Date.parse('2026-10-28T21:18:42Z'));
 assert.match(us.id,/^index:/);assert.equal(us.unit,'点');assert.equal(us.status,'delayed');
 assert.throws(()=>instruments.canonical('sh000001'));assert.equal(rows.find(r=>r.code==='hkHSI').status,'delayed');
 assert.throws(()=>d.parseIndices('v_pv_none_match="1";',now));
 const invalid=samples.tencent_indices.body.replace('~000001~3662.22','~600519~3662.22');assert.equal(d.parseIndices(invalid,now).length,7);
});
test('strict sector parsing preserves source scope and never evaluates executable assignments',()=>{
 const rows=d.parseSectors(samples.sina_industries.body,'industry');assert.equal(rows.length,49);
 assert.equal(rows.find(r=>r.node==='new_fjzz').id,'sina:industry:new_fjzz');
 assert.equal(d.parseSectors(samples.sina_concepts.body,'concept').length,175);
 assert.throws(()=>d.parseSectors(samples.sina_industries.body+';global.pwned=true','industry'));
 assert.throws(()=>d.parseSectors(samples.sina_industries.body,'concept'));
});
test('list adapters validate canonical A share identities, preserve BJ and missing quotes',()=>{
 const rows=d.parseStockRows(samples.sina_rank.body);assert.ok(rows.some(r=>r.asset.market==='BJ'));
 assert.ok(rows.every(r=>r.sourceTime===null));assert.ok(rows.every(r=>/^\d{2}:\d{2}/.test(r.clock)));
 const bad=JSON.stringify([{symbol:'sh000001',code:'000001',name:'指数',trade:'3'},{symbol:'sh600519',code:'600519',name:'茅台',trade:'0'}]);
 assert.equal(d.parseStockRows(bad).length,1);assert.equal(d.parseStockRows(bad)[0].price,null);
});
test('flow parses negative net amounts and confirmed f124 time without renaming source estimates',()=>{
 const row=d.parseFlowRows(samples.east_single_flow.body,now)[0];assert.equal(row.flow.main,-116898704);
 assert.equal(row.flow.superLarge+row.flow.large,row.flow.main);assert.equal(row.sourceTime,1793253249000);
 assert.equal(row.flow.mainPct,-3.06);assert.equal(row.assetId,'sh600519');
 assert.throws(()=>d.parseFlowRows('{"rc":1,"data":{"diff":[]}}',now));
});
test('five levels require exact quote identity and GP-A type; lots become shares',()=>{
 const asset=instruments.canonical('sh600519');const book=d.parseOrderbook(samples.tencent_indices.body,asset,now);
 assert.equal(book.bids[0].volume,300);assert.equal(book.asks[0].volume,100);assert.equal(book.volumeUnit,'share');
 assert.throws(()=>d.parseOrderbook(samples.tencent_indices.body.replace('~GP-A~','~ETF~'),asset,now));
 assert.throws(()=>d.parseOrderbook(samples.tencent_indices.body,instruments.canonical('sz000001'),now));
});
test('service validates modes, sector scope, sort and finite pagination before network I/O',async()=>{
 const {api,requests}=service();for(const event of [{mode:'evil'},{mode:'ranking',sort:'url'},{mode:'ranking',page:0},{mode:'ranking',page:11},{mode:'members',sectorId:'new_fjzz'},{mode:'members',sectorId:'sina:industry:new_missing'}]){
  await assert.rejects(()=>api.handle(event));
 }
 assert.ok(!requests.some(url=>url.includes('node=new_missing')));
 const members=await api.handle({mode:'members',sectorId:'sina:industry:new_fjzz'});assert.equal(members.items[0].assetId,'sh600118');
 assert.equal(members.sourceTime,null);assert.ok(members.fetchedAt);assert.ok(requests.every(url=>!url.includes('undefined')));
});
test('directory search and sorts paginate locally while scopes and cache keys remain isolated',async()=>{
 const {api,cache}=service();const r=await api.handle({mode:'sectors',type:'industry',keyword:'飞机',sort:'changeDesc'});
 assert.equal(r.items.length,1);assert.equal(r.items[0].name,'飞机制造');
 await api.handle({mode:'ranking',sort:'gainers'});await api.handle({mode:'ranking',sort:'losers'});
 assert.ok([...cache.keys()].every(key=>key.startsWith('searchCache:discovery-v1-')));
 assert.ok([...cache.keys()].some(key=>key.includes('gainers')));assert.ok([...cache.keys()].some(key=>key.includes('losers')));
});
test('source failures use at most 24 hour cached values and mark them explicitly',async()=>{
 let fail=false;const {api,advance}=service({request:async()=>{if(fail)throw Error('offline');return samples.tencent_indices.body}});
 const first=await api.handle({mode:'indices'});fail=true;advance(61000);
 const stale=await api.handle({mode:'indices'});assert.equal(stale.stale,true);assert.equal(stale.cached,true);assert.equal(stale.fetchedAt,first.fetchedAt);
 advance(86400000);await assert.rejects(()=>api.handle({mode:'indices'}));
});
test('single stock modules reject unsupported markets and mismatched flow identity',async()=>{
 const {api}=service();await assert.rejects(()=>api.handle({mode:'flow',assetId:'hk00700'}));
 await assert.rejects(()=>api.handle({mode:'flow',assetId:'sh600118'}));
 const r=await api.handle({mode:'flow',assetId:'sh600519'});assert.equal(r.flow.main,-116898704);
});

test('marketData action route exposes discovery without changing stock identity acceptance',async()=>{
 const {createService}=require('../cloudfunctions/marketData');
 const service=createService({now:()=>now,request:async()=>samples.tencent_indices.body});
 const result=await service.handle({action:'discovery',mode:'indices'});assert.equal(result.ok,true);assert.equal(result.items.length,8);
 assert.equal((await service.handle({action:'resolve',assetId:'index:sh000001'})).ok,false);
});
