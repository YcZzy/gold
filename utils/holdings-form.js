// Client-side guidance only. The ledger service remains authoritative.
function inspectDraft(draft) {
 const d=draft||{},errors={};
 const numeric=(key,label,positive=true,optional=false)=>{
  const raw=d[key]==null?'':String(d[key]).trim();
  if(optional&&raw==='')return 0;
  if(!/^\d{1,13}(?:\.\d{1,6})?$/.test(raw)||!Number.isFinite(Number(raw))||Number(raw)>1e12||(positive&&Number(raw)<=0)){
   errors[key]=`${label}请输入${positive?'大于0的':'非负'}数字，最多6位小数且不超过1万亿`;return null;
  }
  return Number(raw);
 };
 if(['openingPosition','buy','sell','income','split'].includes(d.type)&&!d.assetId)errors.assetId='请先选择标的';
 const date=/^\d{4}-\d{2}-\d{2}$/.test(d.date||'')?new Date(d.date+'T00:00:00Z'):null;
 if(!date||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==d.date)errors.date='请选择有效的交易日期';
 let gross=null,fee=0,cash=null,cashLabel='现金变动（预估）',quantity;
 if(['openingPosition','buy','sell'].includes(d.type))quantity=numeric('quantity','数量');
 if(d.type==='openingPosition'){gross=numeric('cost','期初成本',false);cashLabel='期初持仓';}
 if(['buy','sell'].includes(d.type)){
  const price=numeric('price','成交单价');fee=numeric('fee','费用',false,true);
  gross=d.grossAmount!==''&&d.grossAmount!=null&&d.grossAmountMode!=='auto'?numeric('grossAmount','实际成交金额'):quantity==null||price==null?null:Math.round(quantity*price*1e6)/1e6;
  if(gross!=null&&(gross<=0||gross>1e12))errors.grossAmount='成交金额须大于0且不超过1万亿';
  cash=d.type==='buy'?-(gross+fee):gross-fee;
 }
 if(['openingCash','deposit','withdrawal','income','expense'].includes(d.type)){
  gross=numeric('amount','金额',d.type!=='openingCash');cash=['withdrawal','expense'].includes(d.type)?-gross:gross;
  if(d.type==='openingCash')cashLabel='期初现金余额';
 }
 if(d.type==='split'){numeric('numerator','新数量单位');numeric('denominator','原数量单位');}
 if(Object.keys(errors).length)return {errors,preview:null};
 const fmt=v=>v.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:6});
 return {errors,preview:{grossText:gross==null?'—':fmt(gross),feeText:fmt(fee),cashLabel,cashText:cash==null?'不影响现金':(d.type==='openingCash'?'':cash<0?'−':'+')+fmt(Math.abs(cash))}};
}
module.exports={inspectDraft};
