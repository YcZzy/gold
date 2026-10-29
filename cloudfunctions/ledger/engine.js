'use strict';
// Six decimal fixed-point arithmetic; BigInts never cross the JSON boundary.
const SCALE=1000000n, MAX=1000000000000n*SCALE;
const TYPES=['openingPosition','buy','sell','openingCash','deposit','withdrawal','income','expense','split'];
const CURRENCIES=['CNY','HKD','USD'];
function fail(code,message){throw Object.assign(new Error(message),{businessCode:code});}
function decimal(value,positive=false){
 const s=String(value==null?'':value);
 if(!/^\d{1,13}(?:\.\d{1,6})?$/.test(s))fail('bad-decimal','请输入最多6位小数的非负数字');
 const [a,b='']=s.split('.'),v=BigInt(a)*SCALE+BigInt(b.padEnd(6,'0'));
 if(v>MAX||(positive&&v===0n))fail('bad-decimal','数字为零或超出上限');return v;
}
function text(v){const neg=v<0n;v=neg?-v:v;return(neg?'-':'')+String(v/SCALE)+(v%SCALE?'.'+String(v%SCALE).padStart(6,'0').replace(/0+$/,''):'');}
const number=v=>Number(v)/1e6;
const rounded=(a,b)=>(a+b/2n)/b;
const multiply=(a,b)=>rounded(a*b,SCALE);
function localDate(now,zone='Asia/Shanghai'){return new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(now));}
function normalizeEntry(raw,identity,assets,now=Date.now()){
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!TYPES.includes(raw.type))fail('bad-entry','流水类型无效');
 const assetId=raw.assetId||'',asset=assetId&&assets[assetId];
 if(assetId&&!asset)fail('unknown-asset','标的未验证');
 if(['openingPosition','buy','sell','split'].includes(raw.type)&&!asset)fail('unknown-asset','请选择已验证标的');
 if(['openingCash','deposit','withdrawal'].includes(raw.type)&&assetId)fail('bad-entry','现金入出金不能关联证券');
 const currency=asset?asset.currency:raw.currency;
 if(!CURRENCIES.includes(currency)||(raw.currency&&raw.currency!==currency))fail('currency-mismatch','流水币种与标的不一致');
 const date=raw.date;
 if(typeof date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date+'T00:00:00Z'))||new Date(date+'T00:00:00Z').toISOString().slice(0,10)!==date||date<'2000-01-01'||date>localDate(now,(asset&&asset.timezone)||undefined))fail('bad-date','请选择有效的当地历史日期，不能晚于当地今天');
 const note=raw.note==null?'':raw.note;
 if(typeof note!=='string'||Array.from(note).length>200)fail('bad-entry','流水备注最多200字');
 const r={...identity,type:raw.type,date,currency,assetId,note:note.trim(),voided:raw.voided===true};
 if(['openingPosition','buy','sell'].includes(r.type))r.quantity=text(decimal(raw.quantity,true));
 if(r.type==='openingPosition')r.cost=text(decimal(raw.cost));
 if(['buy','sell'].includes(r.type)){
  r.price=text(decimal(raw.price,true));r.fee=text(decimal(raw.fee==null||raw.fee===''?'0':raw.fee));
  if(raw.grossAmountMode!=null&&!['auto','explicit'].includes(raw.grossAmountMode))fail('bad-entry','成交金额来源无效');
  const calculated=multiply(decimal(r.quantity),decimal(r.price)),supplied=raw.grossAmount!=null&&raw.grossAmount!=='';
  r.grossAmountMode=raw.grossAmountMode==='auto'||!supplied?'auto':'explicit';
  const gross=r.grossAmountMode==='auto'?calculated:decimal(raw.grossAmount,true);
  if(gross===0n||gross>MAX)fail('bad-decimal','成交金额必须大于零且不超过上限');r.grossAmount=text(gross);
 }
 if(['openingCash','deposit','withdrawal','income','expense'].includes(r.type))r.amount=text(decimal(raw.amount,r.type!=='openingCash'));
 if(r.type==='split'){
  r.numerator=text(decimal(raw.numerator,true));r.denominator=text(decimal(raw.denominator,true));
 }
 return r;
}
function effective(entries){
 const ids=new Set(),latest=new Map();
 for(const e of entries){
  if(!e||typeof e.id!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(e.id)||ids.has(e.id)||typeof e.logicalId!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(e.logicalId)||!Number.isSafeInteger(e.version)||e.version<1||e.version>1000||!Number.isSafeInteger(e.sequence)||e.sequence<1||e.sequence>1000000000)fail('bad-entry','流水标识、版本或顺序无效');
  ids.add(e.id);const old=latest.get(e.logicalId);
  if(e.version!==(old?old.version+1:1)||old&&e.sequence!==old.sequence)fail('bad-entry','流水修订链无效');latest.set(e.logicalId,e);
 }
 const seen=new Set();
 return [...latest.values()].filter(e=>!e.voided).sort((a,b)=>a.date.localeCompare(b.date)||a.sequence-b.sequence).map(e=>{if(seen.has(e.sequence))fail('bad-entry','流水顺序重复');seen.add(e.sequence);return e;});
}
function internal(entries,assets){
 const ps={},cs={};
 const currency=c=>cs[c]||(cs[c]={currency:c,cash:0n,tracked:false,income:0n,expense:0n});
 for(const e of entries){
  const c=currency(e.currency);let p;
  if(e.assetId){const a=assets[e.assetId];if(!a||a.currency!==e.currency)fail('unknown-asset','标的或币种不一致');p=ps[e.assetId]||(ps[e.assetId]={assetId:e.assetId,quantity:0n,cost:0n,realized:0n,realizedCost:0n,income:0n,expense:0n,invested:0n,opened:false});}
  switch(e.type){
   case 'openingCash':if(c.tracked||c.cash!==0n)fail('bad-entry','期初现金须为该币种首笔现金记录');c.cash=decimal(e.amount);c.tracked=true;break;
   case 'deposit':c.cash+=decimal(e.amount);c.tracked=true;break;
   case 'withdrawal':c.cash-=decimal(e.amount);c.tracked=true;break;
   case 'openingPosition':if(p.opened)fail('bad-entry','期初持仓须为该标的首笔且只能录入一次');p.quantity=decimal(e.quantity);p.cost=decimal(e.cost);p.invested=p.cost;p.opened=true;break;
   case 'buy':{const cost=decimal(e.grossAmount)+decimal(e.fee);p.quantity+=decimal(e.quantity);p.cost+=cost;p.invested+=cost;p.opened=true;c.cash-=cost;c.tracked=true;break;}
   case 'sell':{const q=decimal(e.quantity);if(q>p.quantity)fail('oversell',`${e.date} 卖出数量超过当时持仓`);const cost=q===p.quantity?p.cost:rounded(p.cost*q,p.quantity);p.quantity-=q;p.cost-=cost;const net=decimal(e.grossAmount)-decimal(e.fee);p.realized+=net-cost;p.realizedCost+=cost;c.cash+=net;c.tracked=true;p.opened=true;break;}
   case 'income':{const amount=decimal(e.amount);c.cash+=amount;c.income+=amount;if(p)p.income+=amount;break;}
   case 'expense':{const amount=decimal(e.amount);c.cash-=amount;c.expense+=amount;if(p)p.expense+=amount;break;}
   case 'split':if(!p.quantity)fail('bad-entry','没有持仓不能拆合股');p.quantity=rounded(p.quantity*decimal(e.numerator),decimal(e.denominator));if(!p.quantity)fail('bad-entry','拆合股后的数量低于支持精度');break;
   default:fail('bad-entry','未知流水');
  }
  if(c.cash<0n)fail('insufficient-cash',`${e.date} ${e.currency} 现金不足，请先补充期初现金或入金`);
  if(c.cash>MAX||(p&&(p.quantity>MAX||p.cost>MAX)))fail('bad-decimal','累计金额或数量超过上限');
 }
 return{ps,cs};
}
function replay(entries,assets){
 const active=effective(entries),{ps,cs}=internal(active,assets);
 return{entries:active,positions:Object.values(ps).map(p=>({...assets[p.assetId],assetId:p.assetId,quantity:number(p.quantity),cost:number(p.cost),realized:number(p.realized),realizedCost:number(p.realizedCost),realizedRate:p.realizedCost?Number(p.realized)/Number(p.realizedCost)*100:null,income:number(p.income),expense:number(p.expense),invested:number(p.invested),averageCost:p.quantity?Number(p.cost)/Number(p.quantity):null})),currencies:Object.values(cs).map(c=>({currency:c.currency,cash:number(c.cash),cashTracked:c.tracked,income:number(c.income),expense:number(c.expense)}))};
}
function quoteDecimal(v,positive=true){try{return decimal(v,positive);}catch(_){return null;}}
function evaluate(entries,assets,notes={},quotes=[]){
 const r=replay(entries,assets),active=r.entries,qs=new Map(quotes.map(q=>[q.assetId,q]));
 const positions=r.positions.map(p=>{
  const q=qs.get(p.assetId)||{},price=quoteDecimal(q.price),marketValue=p.quantity===0?0:price===null?null:number(multiply(decimal(p.quantity),price));
  const unrealized=marketValue===null?null:marketValue-p.cost;
  let daily=null,dailyReason='缺少有效交易日或昨收';const d=q.sessionDate,prev=quoteDecimal(q.prevClose);
  const own=active.filter(e=>e.assetId===p.assetId);
  if(p.kind==='gold')dailyReason='黄金交易日及昨收口径待验证';
  else if(d&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&price!==null&&prev!==null){
   if(own.some(e=>e.date>d))dailyReason='最新报价早于部分流水日期';
   else if(own.some(e=>e.date===d&&['openingPosition','split'].includes(e.type)))dailyReason='期初或拆合股日缺少可比基线';
   else{
    // Replay the complete account prefix so cash validation retains its actual history.
    const before=internal(active.filter(e=>e.date<d),assets).ps[p.assetId],q0=before?before.quantity:0n;
    let flow=0n;
    for(const e of own.filter(e=>e.date===d)){
     if(e.type==='buy')flow-=decimal(e.grossAmount)+decimal(e.fee);
     if(e.type==='sell')flow+=decimal(e.grossAmount)-decimal(e.fee);
     if(e.type==='income')flow+=decimal(e.amount);
     if(e.type==='expense')flow-=decimal(e.amount);
    }
    daily=number(multiply(decimal(p.quantity),price)-multiply(q0,prev)+flow);dailyReason='按该交易日最新可用价估算；日内流水先后于报价未核对';
   }
  }
  return{...p,note:notes[p.assetId]||'',price:price===null?null:number(price),marketValue,unrealized:unrealized===null?null:Number(unrealized.toFixed(6)),unrealizedRate:unrealized===null||p.cost===0?null:unrealized/p.cost*100,totalPnl:unrealized===null?null:Number((p.realized+unrealized+p.income-p.expense).toFixed(6)),totalPnlRate:unrealized===null||p.invested===0?null:(p.realized+unrealized+p.income-p.expense)/p.invested*100,daily,dailyReason,sessionDate:d||null,sourceTime:q.sourceTime||null,stale:!!q.stale,status:q.status||'unavailable',source:q.source||null};
 });
 const currencies=r.currencies.map(c=>{
  const ps=positions.filter(p=>p.currency===c.currency),open=ps.filter(p=>p.quantity>0),complete=open.every(p=>p.marketValue!==null),knownValue=ps.reduce((s,p)=>s+(p.marketValue||0),0),equity=complete&&c.cashTracked?knownValue+c.cash:null;
  // Independent cash PnL belongs to the user-entered ledger date, never inferred from fetch time.
  const independent=active.filter(e=>e.currency===c.currency&&!e.assetId&&['income','expense'].includes(e.type));
  const dates=[...new Set([...ps.map(p=>p.sessionDate).filter(Boolean),...independent.map(e=>e.date)])].sort();
  const dailyGroups=dates.map(date=>{const group=ps.filter(p=>p.sessionDate===date),knownCashFlow=number(independent.filter(e=>e.date===date).reduce((sum,e)=>sum+(e.type==='income'?1n:-1n)*decimal(e.amount),0n)),complete=group.length>0&&group.every(p=>p.daily!==null);return{date,complete,value:complete?Number((group.reduce((s,p)=>s+p.daily,0)+knownCashFlow).toFixed(6)):null,knownCashFlow,assetCount:group.length,reason:group.length?'该日期行情与按录入日期归组的独立现金收益/费用':'仅有独立现金流，无对应证券交易日基线'};});
  const cost=ps.reduce((s,p)=>s+p.cost,0),invested=ps.reduce((s,p)=>s+p.invested,0),unrealized=complete?ps.reduce((s,p)=>s+(p.unrealized||0),0):null,totalPnl=complete?ps.reduce((s,p)=>s+p.realized+(p.unrealized||0),0)+c.income-c.expense:null;
  return{...c,complete,valuedCount:open.filter(p=>p.marketValue!==null).length,positionCount:open.length,knownValue,marketValue:complete?knownValue:null,equity,allocation:equity>0?knownValue/equity*100:null,realized:ps.reduce((s,p)=>s+p.realized,0),unrealized,totalPnl,cost,invested,unrealizedRate:complete&&cost>0?unrealized/cost*100:null,totalPnlRate:complete&&invested>0?totalPnl/invested*100:null,dailyGroups};
 });
 return{positions,currencies,entries:r.entries};
}
module.exports={normalizeEntry,replay,evaluate,effective,decimal,text,TYPES,CURRENCIES,fail};
