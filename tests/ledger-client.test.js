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
