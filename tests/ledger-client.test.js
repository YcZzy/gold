const {test}=require('node:test'),assert=require('node:assert/strict');
let createClient;try{({createClient}=require('../utils/ledger-client'));}catch(_){}
test('ledger client forwards revision and reuses request identity after transport uncertainty',async()=>{assert.equal(typeof createClient,'function');let fail=true,calls=[];const c=createClient({cloud:{callFunction:async req=>{calls.push(req);if(fail)throw Error('offline');return{result:{ok:true,revision:1,entries:[],positions:[],currencies:[]}};}}});const entry={type:'deposit',amount:'100'};await assert.rejects(c.saveEntry(entry,0),/offline/);fail=false;await c.saveEntry(entry,0);assert.equal(calls[0].data.requestId,calls[1].data.requestId);assert.equal(calls[1].name,'ledger');assert.equal(calls[1].data.revision,0);});
test('ledger client never makes offline mutation successful and preserves business error codes',async()=>{assert.equal(typeof createClient,'function');const c=createClient({cloud:{callFunction:async()=>({result:{ok:false,err:'revision-conflict',hint:'refresh'}})}});await assert.rejects(c.saveNote('sh600519','note',1),e=>e.code==='revision-conflict');await assert.rejects(createClient({}).list());});
test('invalid cloud credentials produce recovery guidance without retrying or losing request identity',async()=>{
 let rejected=true;const calls=[];
 const c=createClient({cloud:{callFunction:async req=>{calls.push(req);if(rejected)throw {errCode:-1,errMsg:'cloud.callFunction:fail Error: invalid credential, access_token is invalid or not latest'};return {result:{ok:true}};}}});
 const entry={type:'deposit',amount:'100'};
 await assert.rejects(c.saveEntry(entry,0),e=>e instanceof Error&&e.code==='cloud-credential-invalid'&&e.errCode===-1&&/扫码登录/.test(e.hint)&&/草稿/.test(e.hint));
 assert.equal(calls.length,1);rejected=false;await c.saveEntry(entry,0);assert.equal(calls[0].data.requestId,calls[1].data.requestId);
});
test('read transport failures do not claim that a save was attempted',async()=>{
 const c=createClient({cloud:{callFunction:async()=>{throw Error('offline');}}});
 await assert.rejects(c.list(),e=>/读取/.test(e.hint)&&!/保存结果/.test(e.hint));
 await assert.rejects(c.saveNote('sh600519','note',0),e=>/保存结果尚未确认/.test(e.hint));
});

test('overlapping lists share transport and return independent snapshots without caching later reads',async()=>{
 let calls=0,release;const platform={cloud:{callFunction:async()=>{calls++;return new Promise(r=>release=r);}}};const c=createClient(platform);
 const a=c.list(),b=c.list();assert.equal(calls,1);release({result:{ok:true,revision:1,entries:[]}});const [x,y]=await Promise.all([a,b]);x.entries.push('private');assert.deepEqual(y.entries,[]);
 const later=c.list();assert.equal(calls,2);release({result:{ok:true,revision:1}});await later;
});
test('a read started before a write cannot be reused after the write',async()=>{
 const reads=[];const c=createClient({cloud:{callFunction:async req=>req.data.action==='list'?new Promise(r=>reads.push(r)):{result:{ok:true,revision:2}}}});
 const old=c.list();await c.saveNote('sh600519','note',1);const current=c.list();assert.equal(reads.length,2);
 reads[0]({result:{ok:true,revision:1}});reads[1]({result:{ok:true,revision:2}});assert.equal((await old).revision,1);assert.equal((await current).revision,2);
});

test('failed shared reads clear pending transport so retry can recover',async()=>{
 let calls=0;const c=createClient({cloud:{callFunction:async()=>{calls++;if(calls===1)throw Error('offline');return{result:{ok:true,revision:1}};}}});
 const failures=await Promise.allSettled([c.list(),c.list()]);assert.equal(calls,1);assert.ok(failures.every(r=>r.status==='rejected'));assert.equal((await c.list()).revision,1);assert.equal(calls,2);
});
test('identical concurrent writes remain independent transports',async()=>{
 let calls=0;const c=createClient({cloud:{callFunction:async()=>{calls++;return{result:{ok:true}};}}});await Promise.all([c.saveNote('sh600519','note',1),c.saveNote('sh600519','note',1)]);assert.equal(calls,2);
});
