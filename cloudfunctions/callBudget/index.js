// Allocate prepaid invocation credits. No client-supplied identity, amount or month.
const LIMIT = 200, BLOCK = 100;
function monthAt(time) { return new Date(time + 8*3600000).toISOString().slice(0,7); }
function missing(e) { return ['DOCUMENT_NOT_FOUND','DATABASE_DOCUMENT_NOT_EXIST',-502001].includes(e.code || e.errCode) || /document.*(?:not found|not exist|does not exist)/i.test(e.errMsg || e.message || ''); }
function createHandler({db,getOpenid,now=Date.now}) {
  return async () => {
    const openid = getOpenid();
    if (!openid) return {ok:false,err:'no-openid',hint:'请先登录再操作'};
    const month = monthAt(now());
    try {
      return await db.runTransaction(async tx => {
        const ref = tx.collection('cloudCallBudgets').doc(openid+':'+month);
        let saved;
        try { saved = (await ref.get()).data; } catch(e) { if (!missing(e)) throw e; }
        const allocated = saved?.allocated || 0;
        if (!Number.isInteger(allocated) || allocated < 0) throw Error('invalid budget');
        // Old versions may already have leased more than the reduced cap this month.
        // Preserve that ledger and report exhaustion so clients do not retry the lease.
        const grant = Math.max(0,Math.min(BLOCK,LIMIT-allocated));
        if (grant < 2) return {ok:false,err:'cloud-call-budget-exceeded',hint:'本月云端操作额度已用完，行情快照仍可查看，请下月再试',month};
        await ref.set({data:{allocated:allocated+grant,month,updatedAt:now()}});
        // One credit pays for this lease invocation. Never reissue abandoned credits.
        return {ok:true,month,credits:grant-1,allocated:allocated+grant,limit:LIMIT};
      });
    } catch (_) {
      return {ok:false,err:'cloud-call-budget-unavailable',hint:'操作额度服务暂不可用，请稍后重试；已有数据已保留'};
    }
  };
}
exports.createHandler=createHandler;
exports.main=async()=>{
  const cloud=require('wx-server-sdk');cloud.init({env:cloud.DYNAMIC_CURRENT_ENV});
  return createHandler({db:cloud.database(),getOpenid:()=>cloud.getWXContext().OPENID})();
};
