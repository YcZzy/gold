const KEY='market-display-v1';
const DEFAULTS={quiet:false,compact:false,hideAmounts:false,showChange:true,showTime:true,showNotes:true};
const platform=()=>typeof wx==='undefined'?null:wx;
function get(api=platform()) {
  try { const saved=api && api.getStorageSync(KEY); return {...DEFAULTS,...Object.fromEntries(Object.keys(DEFAULTS).filter(k=>saved && typeof saved[k]==='boolean').map(k=>[k,saved[k]]))}; }
  catch (_) { return {...DEFAULTS}; }
}
function save(patch,api=platform()) {
  if (!patch || Object.entries(patch).some(([k,v])=>!Object.prototype.hasOwnProperty.call(DEFAULTS,k) || typeof v!=='boolean')) throw Error('显示设置格式无效');
  const next={...get(api),...patch};
  if (!api || !api.setStorageSync) throw Error('设备存储不可用');
  api.setStorageSync(KEY,next); return next;
}
function colors(base,preferences=get()) {
  if (!preferences.quiet) return base;
  return {...base,up:'#8b8b8b',down:'#8b8b8b',upFill:'rgba(139,139,139,.85)',downFill:'rgba(139,139,139,.85)',
    upArea:'rgba(139,139,139,.10)',downArea:'rgba(139,139,139,.10)',volUp:'rgba(139,139,139,.4)',volDown:'rgba(139,139,139,.4)',
    ma5:'#b0b0b0',ma10:'#7a7a7a',last:'#969696'};
}
module.exports={get,save,colors,DEFAULTS,KEY};
