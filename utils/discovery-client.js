/** Discovery snapshots are independent of quotes/watchlists and never create index assets. */
const MAX_AGE=86400000;
function createClient(platform,now=Date.now) {
  const memory=new Map();
  function keyFor(mode,params) {return 'discovery:v1:'+mode+':'+JSON.stringify(Object.keys(params).sort().map(key=>[key,params[key]]));}
  function read(key) {try {return memory.get(key) || platform?.getStorageSync?.(key);}catch(_){return memory.get(key);}}
  async function call(mode,params={}) {
    const key=keyFor(mode,params);
    let response;
    try {
      if (!platform?.cloud?.callFunction) throw Error('云开发尚未初始化');
      response=await platform.cloud.callFunction({name:'marketData',data:{action:'discovery',mode,...params}});
    } catch(cause) {
      const old=read(key),age=old && now()-old.fetchedAt;
      if (old && age>=0 && age<MAX_AGE) return {...old,stale:true,cached:true,hint:'连接失败，显示本设备缓存快照'};
      const error=Error('市场发现连接失败，请稍后重试');error.cause=cause;throw error;
    }
    const result=response && response.result;
    if (!result || result.ok!==true) throw Error(result?.hint || '市场发现暂不可用');
    if (typeof result.fetchedAt==='number') {
      memory.set(key,result);try {platform.setStorageSync?.(key,result);}catch(_){}
    }
    return result;
  }
  return {
    indices:()=>call('indices'),sectors:(params={})=>call('sectors',params),
    members:(sectorId,params={})=>call('members',{...params,sectorId}),
    ranking:(sort='gainers',page=1)=>call('ranking',{sort,page}),flowRanking:(page=1)=>call('flowRanking',{page}),
    flow:assetId=>call('flow',{assetId}),orderbook:assetId=>call('orderbook',{assetId}),
  };
}
module.exports={...createClient(typeof wx==='undefined'?null:wx),createClient};
