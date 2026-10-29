/** Private ledger: no persistent device cache or optimistic writes. */
function createClient(platform){
 const pending=new Map();
 function identity(key){if(!pending.has(key))pending.set(key,'l'+Date.now().toString(36)+Math.random().toString(36).slice(2,14));return pending.get(key);}
 async function call(action,payload={},mutation=false){
  const key=JSON.stringify({action,...payload}),data={...payload,action};
  if(mutation)data.requestId=identity(key);
  if(!platform||!platform.cloud||!platform.cloud.callFunction)throw Error('台账需要联网，当前草稿尚未保存');
  let result;
  try{result=(await platform.cloud.callFunction({name:'ledger',data})).result;}
  catch(e){e.hint='网络中断，保存结果尚未确认；保留草稿，重试将使用同一请求标识';throw e;}
  if(!result||result.ok!==true){
   if(result&&result.ok===false)pending.delete(key);
   const e=Error(result&&result.hint||'台账服务暂不可用');e.code=result&&result.err||'ledger-unavailable';e.hint=e.message;throw e;
  }
  pending.delete(key);return result;
 }
 return{list:()=>call('list'),saveEntry:(entry,revision,entryId)=>call('saveEntry',{entry,revision,...(entryId?{entryId}:{})},true),voidEntry:(entryId,revision)=>call('voidEntry',{entryId,revision},true),saveNote:(assetId,note,revision)=>call('saveNote',{assetId,note,revision},true),exportBackup:()=>call('export'),previewImport:(backup,revision)=>call('previewImport',{backup,revision}),importBackup:(backup,revision,previewHash)=>call('import',{backup,revision,previewHash},true)};
}
module.exports={...createClient(typeof wx==='undefined'?null:wx),createClient};
