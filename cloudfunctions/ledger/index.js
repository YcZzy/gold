'use strict';
const crypto=require('crypto'),engine=require('./engine'),securities=require('./securities');
const LIMITS={records:1000,assets:30,bytes:512*1024,operations:1000};
const fresh=()=>({schemaVersion:1,revision:0,entries:[],assets:{},notes:{},receipts:{}});
const token=()=>crypto.randomBytes(16).toString('hex');
function stable(value){if(Array.isArray(value))return value.map(stable);if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])]));return value;}
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
function bounded(value){if(Buffer.byteLength(JSON.stringify(value),'utf8')>LIMITS.bytes)engine.fail('ledger-limit','台账或备份超过512KB上限，请先导出备份');}
async function read(ref){try{return(await ref.get()).data;}catch(e){if(e.code==='DOCUMENT_NOT_FOUND'||e.errCode==='DATABASE_DOCUMENT_NOT_EXIST'||/document.*(?:does not exist|not exist|not found)/i.test(e.message||''))return null;throw e;}}
function verifyAsset(found,id){
 if(id==='gold-au9999'||id==='gold-xauusd'){
  const local=id==='gold-au9999'?{code:'AU9999',market:'SGE',currency:'CNY',unit:'元/克'}:{code:'XAU',market:'GLOBAL',currency:'USD',unit:'美元/盎司'};
  if(!found||found.id!==id||found.kind!=='gold'||Object.entries(local).some(([k,v])=>found[k]!==v))engine.fail('unknown-asset','黄金标识或单位验证失败');
  return{id,...local,name:id==='gold-au9999'?'沪金 Au99.99':'伦敦金现',kind:'gold',precision:2,timezone:'Asia/Shanghai'};
 }
 const a=securities.metadata(found,id);if(!a)engine.fail('unknown-asset','证券身份、类型或币种验证失败');return a;
}
function validateNotes(notes,assets){
 if(!notes||typeof notes!=='object'||Array.isArray(notes))engine.fail('bad-note','持仓备注格式无效');
 const next={};for(const[id,note]of Object.entries(notes)){if(!Object.prototype.hasOwnProperty.call(assets,id)||typeof note!=='string'||Array.from(note).length>200)engine.fail('bad-note','备注仅支持已验证标的且最多200字');if(note.trim())next[id]=note.trim();}return next;
}
function capacity(doc){if(doc.entries.length>LIMITS.records||Object.keys(doc.assets).length>LIMITS.assets||Object.keys(doc.receipts).length>LIMITS.operations)engine.fail('ledger-limit','台账上限：30个标的、1000条含修订流水、1000次写操作；请先导出备份');bounded(doc);}
function backup(doc){return{schemaVersion:1,entries:doc.entries,notes:doc.notes};}
function createHandler({db,getOpenid,resolve,getQuotes=async()=>[],now=Date.now}){
 async function resolveMany(ids){
  const unique=[...new Set(ids)];if(unique.length>LIMITS.assets)engine.fail('ledger-limit','最多30个持仓标的');
  if(unique.some(id=>!securities.validId(id)))engine.fail('unknown-asset','备份包含无效标的');
  const result={};for(let i=0;i<unique.length;i+=5)await Promise.all(unique.slice(i,i+5).map(async id=>{result[id]=verifyAsset(await resolve(id),id);}));return result;
 }
 async function imported(input){
  if(!input||input.schemaVersion!==1||!Array.isArray(input.entries))engine.fail('import-invalid','仅支持本工具schemaVersion=1的JSON备份');
  bounded(input);if(input.entries.length>LIMITS.records)engine.fail('ledger-limit','备份超过1000条流水');
  const assets=await resolveMany(input.entries.map(e=>e&&e.assetId).filter(Boolean));
  const entries=input.entries.map(e=>engine.normalizeEntry(e,{id:e.id,logicalId:e.logicalId,version:e.version,sequence:e.sequence},assets,now()));
  engine.replay(entries,assets);const notes=validateNotes(input.notes||{},assets),doc={...fresh(),entries,assets,notes};capacity(doc);return doc;
 }
 async function view(doc){
  let quotes=[],quoteWarning='';const ids=Object.keys(doc.assets);
  if(ids.length)try{const r=await getQuotes(ids);quotes=Array.isArray(r)?r:r&&Array.isArray(r.quotes)?r.quotes:[];if(quotes.length<ids.length)quoteWarning='部分行情暂不可用，合计已标明缺失';}catch(_){quoteWarning='行情暂不可用，账本已保留，估值显示缺失';}
  const result=engine.evaluate(doc.entries,doc.assets,doc.notes,quotes);
  return{ok:true,revision:doc.revision,...result,assets:Object.values(doc.assets),notes:doc.notes,auditCount:doc.entries.length,operationCount:Object.keys(doc.receipts).length,limits:LIMITS,quoteWarning};
 }
 return async(event={})=>{
  const owner=getOpenid();if(!owner)return{ok:false,err:'no-openid',hint:'请先登录再操作台账'};
  try{
   const action=event.action||'list',ref=db.collection('investmentLedgers').doc(owner);
   if(!['list','export','saveEntry','voidEntry','saveNote','previewImport','import'].includes(action))engine.fail('bad-action','不支持的台账操作');
   if(action==='list'){const doc=(await read(ref))||fresh();if(doc.ownerOpenid&&doc.ownerOpenid!==owner)engine.fail('forbidden','台账归属不匹配');return await view(doc);}
   if(action==='export'){const doc=(await read(ref))||fresh();if(doc.ownerOpenid&&doc.ownerOpenid!==owner)engine.fail('forbidden','台账归属不匹配');return{ok:true,revision:doc.revision,backup:backup(doc)};}
   if(!Number.isInteger(event.revision)||event.revision<0)engine.fail('revision-conflict','请先加载最新台账');
   let prepared=null,resolved={};
   if(action==='previewImport'||action==='import')prepared=await imported(event.backup);
   if(action==='saveEntry'&&event.entry&&event.entry.assetId)resolved=await resolveMany([event.entry.assetId]);
   if(action==='previewImport'){
    const doc=(await read(ref))||fresh();if(doc.revision!==event.revision)engine.fail('revision-conflict','台账已更新，请重新生成导入预览');
    return{ok:true,revision:doc.revision,previewHash:hash({revision:doc.revision,backup:backup(prepared)}),preview:await view(prepared),previousCount:engine.effective(doc.entries).length};
   }
   if(typeof event.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(event.requestId))engine.fail('bad-request','操作请求标识无效');
   const requestHash=hash({action,entry:event.entry||null,entryId:event.entryId||null,assetId:event.assetId||null,note:event.note==null?null:event.note,backup:prepared?backup(prepared):null,previewHash:event.previewHash||null});
   const saved=await db.runTransaction(async tx=>{
    const target=tx.collection('investmentLedgers').doc(owner),existing=(await read(target))||fresh();
    if(existing.ownerOpenid&&existing.ownerOpenid!==owner)engine.fail('forbidden','台账归属不匹配');
    const receipt=existing.receipts[event.requestId];
    if(receipt){if(receipt.hash!==requestHash)engine.fail('duplicate-request','相同请求标识不能提交不同内容');return{doc:existing,duplicate:true};}
    if(existing.revision!==event.revision)engine.fail('revision-conflict','台账已更新，请刷新后核对草稿再保存');
    const doc={...existing,entries:[...existing.entries],assets:{...existing.assets,...resolved},notes:{...existing.notes},receipts:{...existing.receipts}};
    if(action==='import'){
     if(event.previewHash!==hash({revision:existing.revision,backup:backup(prepared)}))engine.fail('import-invalid','请先预览同一份备份，再确认恢复');
     doc.entries=prepared.entries;doc.assets=prepared.assets;doc.notes=prepared.notes;
    }
    if(action==='saveEntry'||action==='voidEntry'){
     let previous;
     if(event.entryId){previous=[...doc.entries].reverse().find(e=>e.logicalId===event.entryId);if(!previous||previous.voided)engine.fail('bad-entry','流水已撤销或不存在');}
     if(action==='voidEntry'&&!previous)engine.fail('bad-entry','请选择要撤销的流水');
     const id=token(),identity={id,logicalId:previous?previous.logicalId:id,version:previous?previous.version+1:1,sequence:previous?previous.sequence:Math.max(0,...doc.entries.map(e=>e.sequence))+1};
     const entry=engine.normalizeEntry(action==='voidEntry'?{...previous,voided:true}:event.entry,identity,doc.assets,now());doc.entries.push(entry);
    }
    if(action==='saveNote'){
     if(!Object.prototype.hasOwnProperty.call(doc.assets,event.assetId))engine.fail('unknown-asset','请先录入该标的持仓流水');
     doc.notes=validateNotes({...doc.notes,[event.assetId]:event.note},doc.assets);
    }
    engine.replay(doc.entries,doc.assets);doc.revision=existing.revision+1;doc.ownerOpenid=owner;doc.updatedAt=now();doc.createdAt=existing.createdAt||now();
    doc.receipts[event.requestId]={hash:requestHash,revision:doc.revision};delete doc._id;capacity(doc);await target.set({data:doc});return{doc,duplicate:false};
   });
   return{...await view(saved.doc),duplicate:saved.duplicate};
  }catch(e){return{ok:false,err:e.businessCode||'ledger-unavailable',hint:e.businessCode?e.message:'台账服务暂不可用，请保留草稿后重试'};}
 };
}
exports.createHandler=createHandler;exports.LIMITS=LIMITS;
exports.main=async event=>{
 const cloud=require('wx-server-sdk');cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
 return createHandler({db:cloud.database(),getOpenid:()=>cloud.getWXContext().OPENID,resolve:async assetId=>{const r=(await cloud.callFunction({name:'marketData',data:{action:'resolve',assetId}})).result;if(!r||!r.ok||!r.asset)engine.fail('unknown-asset','标的验证暂不可用，请重试');return r.asset;},getQuotes:async assetIds=>{const r=(await cloud.callFunction({name:'marketData',data:{action:'quotes',assetIds}})).result;if(!r||!r.ok)throw Error('quote unavailable');return r.quotes||[];}})(event);
};
