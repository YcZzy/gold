const {test}=require('node:test'),assert=require('node:assert/strict');
const {memoryDb}=require('./helpers/asset-db');
let createHandler;try{({createHandler}=require('../cloudfunctions/ledger'));}catch(_){}
const asset={id:'sh600519',name:'贵州茅台',code:'600519',market:'SH',kind:'stock',currency:'CNY',unit:'元/股',precision:2,timezone:'Asia/Shanghai',secid:'1.600519',quoteCode:'sh600519'};
function setup(){assert.equal(typeof createHandler,'function','ledger handler must exist');const {db,tables}=memoryDb();let user='a',resolved=[];const main=createHandler({db,getOpenid:()=>user,resolve:async id=>{resolved.push(id);if(id!==asset.id)throw Error('unknown');return asset;},getQuotes:async()=>[{assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29'}],now:()=>Date.parse('2026-10-29T12:00Z')});return{main,tables,resolved,user:x=>user=x};}
const initial={type:'openingPosition',assetId:asset.id,date:'2026-10-28',quantity:'100',cost:'800',currency:'CNY'};
const save=(f,entry,revision,requestId,extra={})=>f.main({action:'saveEntry',entry,revision,requestId,...extra});
test('ledger transactions isolate users and require server identity with no automatic defaults',async()=>{const f=setup();let r=await f.main();assert.equal(r.revision,0);assert.deepEqual(r.entries,[]);r=await save(f,initial,0,'one');assert.equal(r.ok,true,r.hint);assert.equal(r.positions[0].quantity,100);f.user('b');r=await f.main({openid:'a'});assert.equal(r.entries.length,0);f.user('');assert.equal((await f.main()).err,'no-openid');assert.equal(f.tables.investmentLedgers[0]._id,'a');});
test('idempotent retries do not duplicate entries and concurrent revisions cannot overwrite',async()=>{const f=setup();const results=await Promise.all([save(f,initial,0,'one'),save(f,{...initial,cost:'900'},0,'two')]);assert.equal(results.filter(x=>x.ok).length,1);assert.equal(results.find(x=>!x.ok).err,'revision-conflict');let r=await save(f,initial,0,'one');assert.equal(r.ok,true);assert.equal(r.duplicate,true);assert.equal(r.entries.length,1);assert.equal((await save(f,{...initial,cost:'900'},0,'one')).err,'duplicate-request');});
test('editing and voiding replay atomically while retaining audit and independent notes',async()=>{const f=setup();let r=await save(f,initial,0,'one');const id=r.entries[0].logicalId;r=await save(f,{type:'sell',assetId:asset.id,currency:'CNY',date:'2026-10-29',quantity:50,price:12,fee:5},r.revision,'two');assert.equal(r.ok,true,r.hint);const snapshot=structuredClone(f.tables.investmentLedgers);let bad=await f.main({action:'voidEntry',entryId:id,revision:r.revision,requestId:'void'});assert.equal(bad.err,'oversell');assert.deepEqual(f.tables.investmentLedgers,snapshot);r=await save(f,{...initial,cost:900},r.revision,'edit',{entryId:id});assert.equal(r.positions[0].cost,450);assert.equal(r.auditCount,3);r=await f.main({action:'saveNote',assetId:asset.id,note:'私人持仓备注',revision:r.revision,requestId:'note'});assert.equal(r.positions[0].note,'私人持仓备注');assert.equal(f.tables.portfolios,undefined);});
test('backup excludes identity, resolves imported assets, previews and restores only at matching revision',async()=>{const f=setup();let r=await save(f,initial,0,'one');const out=await f.main({action:'export'});assert.equal(out.ok,true);assert.equal(JSON.stringify(out.backup).includes('ownerOpenid'),false);assert.equal(JSON.stringify(out.backup).includes('receipts'),false);f.user('b');let p=await f.main({action:'previewImport',backup:{...out.backup,assets:{[asset.id]:{...asset,currency:'USD'}}},revision:0});assert.equal(p.ok,true,p.hint);assert.equal(p.preview.positions[0].currency,'CNY');assert.ok(f.resolved.length>=2);r=await f.main({action:'import',backup:out.backup,previewHash:p.previewHash,revision:0,requestId:'restore'});assert.equal(r.ok,true,r.hint);assert.equal(r.positions[0].cost,800);assert.equal((await f.main({action:'import',backup:out.backup,previewHash:p.previewHash,revision:0,requestId:'new'})).err,'revision-conflict');assert.equal((await f.main({action:'import',backup:out.backup,previewHash:'fake',revision:1,requestId:'fake'})).err,'import-invalid');});
test('malformed imported IDs and metadata failure cannot mutate the document',async()=>{const f=setup();const r=await f.main({action:'previewImport',revision:0,backup:{schemaVersion:1,entries:[{...initial,assetId:'__proto__',id:'a',logicalId:'a',version:1,sequence:1}],notes:{}}});assert.equal(r.ok,false);assert.equal((f.tables.investmentLedgers||[]).length,0);});
test('1000 record and 512KB bounds reject input without writes',async()=>{const f=setup();const backup={schemaVersion:1,entries:Array.from({length:1001},(_,i)=>({...initial,id:'a'+i,logicalId:'a'+i,version:1,sequence:i+1})),notes:{}};assert.equal((await f.main({action:'previewImport',backup,revision:0})).err,'ledger-limit');assert.equal((f.tables.investmentLedgers||[]).length,0);});
test('quote outages retain saved ledger and make valuations explicitly partial',async()=>{const {db}=memoryDb();const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:async()=>{throw Error('network');},now:()=>Date.parse('2026-10-29T12:00Z')});const r=await main({action:'saveEntry',entry:initial,revision:0,requestId:'a'});assert.equal(r.ok,true);assert.equal(r.positions[0].marketValue,null);assert.equal(r.currencies[0].complete,false);assert.match(r.quoteWarning,/行情/);});
test('corrected audit chains and notes survive backup without trusting permissions or owner',async()=>{const f=setup();let r=await save(f,initial,0,'one');const logicalId=r.entries[0].logicalId;r=await save(f,{...initial,cost:'900'},r.revision,'edit',{entryId:logicalId});r=await f.main({action:'saveNote',assetId:asset.id,note:'备份备注',revision:r.revision,requestId:'note'});const out=await f.main({action:'export'});assert.equal(out.backup.entries.length,2);f.user('b');const backup={...out.backup,ownerOpenid:'a',receipts:{injected:true},tier:'vip'};const p=await f.main({action:'previewImport',backup,revision:0});r=await f.main({action:'import',backup,revision:0,requestId:'restore',previewHash:p.previewHash});assert.equal(r.ok,true,r.hint);assert.equal(r.auditCount,2);assert.equal(r.positions[0].cost,900);assert.equal(r.positions[0].note,'备份备注');const saved=f.tables.investmentLedgers.find(x=>x._id==='b');assert.equal(saved.ownerOpenid,'b');assert.equal(saved.tier,undefined);assert.equal(saved.receipts.injected,undefined);});
test('import rejects oversized payload and invalid version chains atomically',async()=>{const f=setup();assert.equal((await f.main({action:'previewImport',revision:0,backup:{schemaVersion:1,entries:[],notes:{},padding:'x'.repeat(512*1024)}})).err,'ledger-limit');const backup={schemaVersion:1,entries:[{...initial,id:'a',logicalId:'a',version:2,sequence:1}],notes:{}};assert.equal((await f.main({action:'previewImport',revision:0,backup})).err,'bad-entry');assert.equal((f.tables.investmentLedgers||[]).length,0);});
test('editing a calculated historical buy price recomputes remaining cost and cash',async()=>{const f=setup();let r=await save(f,{type:'openingCash',date:'2026-10-28',currency:'CNY',amount:'5000'},0,'cash');r=await save(f,{type:'buy',assetId:asset.id,date:'2026-10-28',currency:'CNY',quantity:'100',price:'10',fee:'0'},r.revision,'buy');const buy=r.entries.find(e=>e.type==='buy');assert.equal(buy.grossAmountMode,'auto');r=await save(f,{...buy,price:'20'},r.revision,'edit-price',{entryId:buy.logicalId});assert.equal(r.ok,true,r.hint);assert.equal(r.positions[0].cost,2000);assert.equal(r.currencies[0].cash,3000);assert.equal(r.entries.find(e=>e.type==='buy').grossAmount,'2000');});
test('the reported gold opening entry is valid and does not require initial cash',async()=>{
 const {db}=memoryDb();const gold={id:'gold-au9999',name:'沪金 Au99.99',code:'AU9999',market:'SGE',kind:'gold',currency:'CNY',unit:'元/克'};
 const main=createHandler({db,getOpenid:()=> 'test-user',resolve:async()=>gold,now:()=>Date.parse('2026-10-30T08:00:00Z')});
 const r=await main({action:'saveEntry',revision:0,requestId:'reported-gold-opening',entry:{type:'openingPosition',date:'2026-10-30',currency:'CNY',assetId:gold.id,quantity:'200',price:'',fee:'0',cost:'1000',amount:'',grossAmount:'',grossAmountMode:'auto',note:'',numerator:'2',denominator:'1'}});
 assert.equal(r.ok,true,r.hint);assert.equal(r.positions[0].quantity,200);assert.equal(r.positions[0].cost,1000);assert.equal(r.currencies[0].cashTracked,false);
});
test('SDK errors with errMsg-only missing documents initialize the first ledger',async()=>{
 const {db}=memoryDb(),original=db.runTransaction;
 db.runTransaction=fn=>original(async tx=>{const collection=tx.collection.bind(tx);tx.collection=name=>{const c=collection(name),doc=c.doc.bind(c);c.doc=id=>{const ref=doc(id),get=ref.get;ref.get=async()=>{try{return await get();}catch(e){throw {errCode:-502001,errMsg:'document.get:fail document does not exist'};}};return ref;};return c;};return fn(tx);});
 const main=createHandler({db,getOpenid:()=> 'test-user',resolve:async()=>asset,now:()=>Date.parse('2026-10-30T08:00:00Z')});const r=await main({action:'saveEntry',revision:0,requestId:'first',entry:initial});assert.equal(r.ok,true,r.hint);
});
test('missing collection is not treated as an empty ledger and reports initialization guidance',async()=>{
 const logs=[],db={collection:()=>({doc:()=>({get:async()=>{throw {errCode:-502005,errMsg:'document.get:fail collection investmentLedgers does not exist'};}})})};
 const main=createHandler({db,getOpenid:()=> 'private-owner',resolve:async()=>asset,logger:{error:(...args)=>logs.push(args)}});const r=await main({action:'list'});assert.equal(r.ok,false);assert.equal(r.err,'ledger-not-initialized');assert.match(r.hint,/initDb/);assert.equal(logs[0][1].stage,'read-ledger');assert.ok(!JSON.stringify(logs).includes('private-owner'));
});
test('unexpected errors record the failing stage without logging transaction inputs',async()=>{
 const {db}=memoryDb(),logs=[];const main=createHandler({db,getOpenid:()=> 'private-owner',resolve:async()=>{throw Error('upstream unavailable');},logger:{error:(...args)=>logs.push(args)}});
 const r=await main({action:'saveEntry',entry:{...initial,note:'private-note'},revision:0,requestId:'diagnostic'});assert.equal(r.err,'ledger-unavailable');assert.equal(logs[0][1].stage,'resolve-assets');assert.match(logs[0][1].message,/upstream unavailable/);assert.ok(!JSON.stringify(logs).includes('private-note'));assert.ok(!JSON.stringify(logs).includes('private-owner'));
});
test('unexpected errors expose a safe diagnostic without requiring access to cloud logs',async()=>{
 const {db}=memoryDb();const main=createHandler({db,getOpenid:()=> 'private-owner',resolve:async()=>{throw Object.assign(Error('private-note credential=secret'),{errCode:-504003});},logger:{error(){}}});
 const r=await main({action:'saveEntry',entry:initial,revision:0,requestId:'diag-response'});assert.deepEqual(r.diagnostic,{stage:'resolve-assets',code:'-504003',version:1});assert.equal(JSON.stringify(r).includes('private-note'),false);assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(JSON.stringify(r).includes('private-owner'),false);
});

test('fresh server instrument metadata avoids nested resolve and stale metadata falls back',async()=>{
 const timestamp=Date.parse('2026-10-29T12:00Z');
 for(const age of [1000,86400000,-1000]){
  const {db}=memoryDb({instruments:[{_id:asset.id,asset,updatedAt:timestamp-age}]});let resolves=0;
  const main=createHandler({db,getOpenid:()=> 'a',now:()=>timestamp,resolve:async()=>{resolves++;return asset;}});
  const r=await main({action:'saveEntry',entry:initial,revision:0,requestId:'cache'});
  assert.equal(r.ok,true,r.hint);assert.equal(resolves,age===1000?0:1);
 }
});
test('invalid cached instrument identity is reverified remotely',async()=>{
 const timestamp=Date.parse('2026-10-29T12:00Z');const {db}=memoryDb({instruments:[{_id:asset.id,asset:{...asset,currency:'USD'},updatedAt:timestamp}]});let resolves=0;
 const main=createHandler({db,getOpenid:()=> 'a',now:()=>timestamp,resolve:async()=>{resolves++;return asset;}});
 assert.equal((await main({action:'saveEntry',entry:initial,revision:0,requestId:'bad-cache'})).ok,true);assert.equal(resolves,1);
});
test('fully closed holdings no longer request quotes but retain realized profit',async()=>{
 const {db}=memoryDb();const requests=[];
 const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:async ids=>{requests.push(ids);return[{assetId:asset.id,price:11}];},now:()=>Date.parse('2026-10-29T12:00Z')});
 await main({action:'saveEntry',entry:initial,revision:0,requestId:'open'});requests.length=0;
 const r=await main({action:'saveEntry',entry:{type:'sell',assetId:asset.id,currency:'CNY',date:'2026-10-29',quantity:'100',price:'12',fee:'0'},revision:1,requestId:'close'});
 assert.equal(r.ok,true,r.hint);assert.equal(requests.length,0);assert.equal(r.positions[0].realized,400);assert.equal(r.currencies[0].complete,true);
 await main({action:'list'});assert.equal(requests.length,0);
});
test('note saves use shared quotes without nested market calls and mark old quotes stale',async()=>{
 const timestamp=Date.parse('2026-10-29T12:00Z');
 const {db}=memoryDb({quoteCache:[{_id:asset.id,assetId:asset.id,price:11,prevClose:10,sessionDate:'2026-10-29',sourceTime:timestamp-60000,fetchedAt:timestamp-60000,status:'fresh',source:'test'}]});let calls=0;
 const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:async()=>{calls++;return[];},now:()=>timestamp});
 await main({action:'saveEntry',entry:initial,revision:0,requestId:'open'});calls=0;
 const r=await main({action:'saveNote',assetId:asset.id,note:'new',revision:1,requestId:'note'});
 assert.equal(r.ok,true,r.hint);assert.equal(calls,0);assert.equal(r.positions[0].marketValue,1100);assert.equal(r.positions[0].stale,true);assert.match(r.quoteWarning,/缓存/);assert.equal(r.positions[0].note,'new');
});
test('slow quotes cannot hold a successful ledger write indefinitely',async()=>{
 const {db}=memoryDb();const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:()=>new Promise(()=>{}),quoteTimeoutMs:10,now:()=>Date.parse('2026-10-29T12:00Z')});
 const r=await main({action:'saveEntry',entry:initial,revision:0,requestId:'slow'});
 assert.equal(r.ok,true,r.hint);assert.equal(r.revision,1);assert.equal(r.positions[0].marketValue,null);assert.match(r.quoteWarning,/行情/);
});

test('unusable note quote caches stay incomplete without remote refresh',async()=>{
 const timestamp=Date.parse('2026-10-29T12:00Z');
 for(const q of [null,{assetId:'wrong',fetchedAt:timestamp},{assetId:asset.id,fetchedAt:timestamp+1000},{assetId:asset.id,fetchedAt:timestamp-7*86400000}]){
  const {db}=memoryDb({quoteCache:q?[{_id:asset.id,price:11,...q}]:[]});let calls=0;
  const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:async()=>{calls++;return[];},now:()=>timestamp});
  await main({action:'saveEntry',entry:initial,revision:0,requestId:'open'});calls=0;
  const r=await main({action:'saveNote',assetId:asset.id,note:'note',revision:1,requestId:'note'});
  assert.equal(r.ok,true,r.hint);assert.equal(calls,0);assert.equal(r.positions[0].marketValue,null);assert.equal(r.currencies[0].complete,false);
 }
});
test('gold identity is server-local and requires no nested resolve',async()=>{
 const {db}=memoryDb();let resolves=0;const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>{resolves++;throw Error('offline');},now:()=>Date.parse('2026-10-29T12:00Z')});
 const r=await main({action:'saveEntry',entry:{...initial,assetId:'gold-au9999'},revision:0,requestId:'gold'});assert.equal(r.ok,true,r.hint);assert.equal(resolves,0);assert.equal(r.positions[0].currency,'CNY');
});

test('buy without funding saves and unfunded edits and imports retain quantity validation',async()=>{
 const f=setup();let r=await save(f,{type:'buy',assetId:asset.id,currency:'CNY',date:'2026-10-28',quantity:100,price:10,fee:5},0,'unfunded');
 assert.equal(r.ok,true,r.hint);assert.equal(r.currencies[0].cash,null);assert.equal(r.currencies[0].cashTracked,false);
 r=await save(f,{type:'sell',assetId:asset.id,currency:'CNY',date:'2026-10-29',quantity:101,price:12},1,'oversell');assert.equal(r.err,'oversell');
 const saved=await f.main({action:'list'}),entry=saved.entries[0];r=await save(f,{...entry,quantity:200},1,'edit-unfunded',{entryId:entry.logicalId});assert.equal(r.ok,true,r.hint);assert.equal(r.positions[0].cost,2005);
 const backup=(await f.main({action:'export'})).backup;f.user('b');const preview=await f.main({action:'previewImport',backup,revision:0});assert.equal(preview.ok,true,preview.hint);assert.equal(preview.preview.positions[0].quantity,200);
 f.user('a');r=await f.main({action:'voidEntry',entryId:entry.logicalId,revision:2,requestId:'void-unfunded'});assert.equal(r.ok,true,r.hint);assert.equal(r.positions.length,0);
});

test('listing and saving a ledger never wait for external market providers',async()=>{
 const {db}=memoryDb();let calls=0;const timestamp=Date.parse('2026-11-02T02:00Z');
 const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,getQuotes:async()=>{calls++;throw Error('provider unavailable');},now:()=>timestamp});
 const saved=await main({action:'saveEntry',entry:initial,revision:0,requestId:'fast-open'});
 assert.equal(saved.ok,true);assert.equal(calls,0);
 const listed=await main({action:'list'});assert.equal(listed.ok,true);assert.equal(listed.positions[0].quantity,100);assert.equal(calls,0);assert.equal(listed.positions[0].marketValue,null);
});
test('holdings valuations read one bounded cache query instead of one database request per asset',async()=>{
 const timestamp=Date.parse('2026-11-02T02:00Z');const {db}=memoryDb({quoteCache:[{_id:asset.id,assetId:asset.id,price:11,fetchedAt:timestamp,sourceTime:timestamp,status:'fresh'}]});
 let queries=0,docs=0;const original=db.collection;db.collection=name=>{const q=original(name);if(name==='quoteCache'){const doc=q.doc;q.doc=id=>{docs++;return doc(id);};const where=q.where;q.where=f=>{queries++;return where(f);};}return q;};
 const main=createHandler({db,getOpenid:()=> 'a',resolve:async()=>asset,now:()=>timestamp});await main({action:'saveEntry',entry:initial,revision:0,requestId:'cache-open'});queries=0;docs=0;
 const r=await main({action:'list'});assert.equal(r.positions[0].marketValue,1100);assert.equal(queries,1);assert.equal(docs,0);assert.doesNotMatch(r.quoteWarning,/备注已保存/);
});
