'use strict';
const instruments = require('./instruments');
const { localTime, localLabel } = require('./market-time');
const PAGE_SIZE = 20, MAX_PAGE = 10, MAX_AGE = 86400000;
const INDEX_DEFINITIONS = [
  ['sh000001','上证指数','SH','000001'], ['sz399001','深证成指','SZ','399001'],
  ['sz399006','创业板指','SZ','399006'], ['sh000688','科创50','SH','000688'],
  ['bj899050','北证50','BJ','899050'], ['hkHSI','恒生指数','HK','HSI'],
  ['us.IXIC','纳斯达克综合','US','.IXIC'], ['us.INX','标普500','US','.INX'],
].map(([code,name,market,providerCode])=>({id:'index:'+code,code,name,market,providerCode,
  kind:'index',unit:'点',timezone:market==='US'?'America/New_York':market==='HK'?'Asia/Hong_Kong':'Asia/Shanghai'}));
function text(input) {
  if (!Buffer.isBuffer(input)) return String(input);
  try { return require('iconv-lite').decode(input,'gb18030'); }
  catch (_) { return new TextDecoder('gb18030').decode(input); }
}
function numeric(value) {
  if (value == null || value === '' || value === '-' || typeof value === 'boolean') return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
}
function positive(value) { const n=numeric(value);return n!==null && n>0?n:null; }
function json(input) {
  return typeof input==='object' && !Buffer.isBuffer(input) ? input : JSON.parse(Buffer.isBuffer(input)?input.toString('utf8'):input);
}
function quoteFields(input, code) {
  const escaped=code.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=new RegExp('(?:^|[;\\s])v_'+escaped+'="([^"\\r\\n]*)";?(?=\\s|$)').exec(text(input));
  return match && match[1].split('~');
}
function parseIndices(input, now=Date.now()) {
  const rows=[];
  for (const def of INDEX_DEFINITIONS) {
    const p=quoteFields(input,def.code);
    if (!p || p[2]!==def.providerCode || !p[1] || !positive(p[3])) continue;
    // Domestic and HK indices identify themselves as ZS; US index feeds omit this label.
    if (def.market!=='US' && !p.includes('ZS')) continue;
    const sourceTime=localTime(p[30],def.timezone,now);
    if (sourceTime===null) continue;
    rows.push({...def,price:positive(p[3]),change:numeric(p[31]),changePct:numeric(p[32]),source:'tencent',
      sourceTime,sourceLabel:localLabel(sourceTime,def.timezone),fetchedAt:now,status:now-sourceTime>900000?'delayed':'fresh'});
  }
  if (!rows.length) throw Error('指数数据暂不可用');
  return rows;
}
function parseSectors(input,type) {
  const variable={industry:'S_Finance_bankuai_sinaindustry',concept:'S_Finance_bankuai_class'}[type];
  if (!variable) throw Error('板块类型无效');
  const match=new RegExp('^\\s*var\\s+'+variable+'\\s*=\\s*(\\{[\\s\\S]*\\})\\s*;?\\s*$').exec(text(input));
  if (!match) throw Error('板块响应格式无效');
  const object=JSON.parse(match[1]);
  if (!object || Array.isArray(object) || typeof object!=='object') throw Error('板块目录无效');
  const prefix=type==='industry'?'new_':'gn_';
  const rows=Object.entries(object).flatMap(([key,value])=>{
    if (typeof value!=='string') return [];
    const p=value.split(',');
    if (p.length!==13 || p[0]!==key || !new RegExp('^'+prefix+'[A-Za-z0-9_]+$').test(key) || !p[1]) return [];
    return [{id:'sina:'+type+':'+key,node:key,type,name:p[1],count:numeric(p[2]),changePct:numeric(p[5]),
      amount:numeric(p[7]),leaderSymbol:p[8],leaderName:p[12],leaderChangePct:numeric(p[9]),sourceTime:null}];
  });
  if (!rows.length) throw Error('板块目录为空');
  return rows;
}
function verifiedAsset(id, code, name) {
  try {
    const asset=instruments.canonical(id);
    if (asset.code!==String(code) || asset.kind!=='stock' || !['SH','SZ','BJ'].includes(asset.market)) return null;
    return {...asset,name:typeof name==='string' && name?name:asset.name};
  } catch (_) { return null; }
}
function parseStockRows(input) {
  const raw=json(input);
  if (!Array.isArray(raw)) throw Error('证券列表响应格式无效');
  const seen=new Set();
  return raw.flatMap(row=>{
    const asset=verifiedAsset(row.symbol,row.code,row.name);
    if (!asset || seen.has(asset.id)) return [];
    seen.add(asset.id);
    return [{asset,assetId:asset.id,name:asset.name,price:positive(row.trade),changePct:numeric(row.changepercent),
      amount:numeric(row.amount),sourceTime:null,clock:/^\d{2}:\d{2}(?::\d{2})?$/.test(row.ticktime || '')?row.ticktime:null}];
  });
}
function parseFlowRows(input,now=Date.now()) {
  const raw=json(input);
  if (raw?.rc!==0 || !Array.isArray(raw?.data?.diff)) throw Error('资金流向响应无效');
  return raw.data.diff.flatMap(row=>{
    const id=(row.f13===1?'sh':row.f13===0?'sz':'')+row.f12;
    const asset=verifiedAsset(id,row.f12,row.f14);
    const main=numeric(row.f62),stamp=numeric(row.f124),sourceTime=stamp===null?null:stamp*1000;
    if (!asset || main===null || sourceTime===null || sourceTime<Date.UTC(2000,0,1) || sourceTime>now+300000) return [];
    return [{asset,assetId:asset.id,name:asset.name,sourceTime,flow:{main,mainPct:numeric(row.f184),
      superLarge:numeric(row.f66),superLargePct:numeric(row.f69),large:numeric(row.f72),largePct:numeric(row.f75),
      medium:numeric(row.f78),mediumPct:numeric(row.f81),small:numeric(row.f84),smallPct:numeric(row.f87)}}];
  });
}
function parseOrderbook(input,asset,now=Date.now()) {
  if (asset.kind!=='stock' || !['SH','SZ'].includes(asset.market)) throw Error('五档仅支持沪深 A 股股票');
  const p=quoteFields(input,asset.quoteCode || asset.id);
  if (!p || p[2]!==asset.code || p[61]!=='GP-A' || !p[1] || !positive(p[3])) throw Error('五档证券身份或类型未确认');
  const sourceTime=localTime(p[30],'Asia/Shanghai',now);
  if (sourceTime===null) throw Error('五档来源时间无效');
  const levels=offset=>Array.from({length:5},(_,i)=>{
    const price=positive(p[offset+i*2]),lots=numeric(p[offset+i*2+1]);
    return {price,volume:lots!==null && lots>=0?lots*100:null};
  });
  return {asset:{...asset,name:p[1]},bids:levels(9),asks:levels(19),volumeUnit:'share',source:'tencent',sourceTime,fetchedAt:now};
}
function validatePage(value) {
  const page=value===undefined?1:value;
  if (!Number.isInteger(page) || page<1 || page>MAX_PAGE) throw Error('页码需为 1 至 '+MAX_PAGE);
  return page;
}
const SORTS={gainers:['changepercent',0],losers:['changepercent',1],amount:['amount',0]};
const SECTOR_SORTS=['changeDesc','changeAsc','amountDesc','name'];
function createDiscovery(options) {
  const {request,resolve}=options,now=options.now || Date.now;
  const memory=new Map(),pending=new Map();
  async function read(key) {
    const local=memory.get(key);
    if (local) return local;
    try { return await options.get?.('searchCache',key); } catch (_) { return null; }
  }
  async function cached(key,ttl,load) {
    key='discovery-v1-'+key;
    const old=await read(key),age=old && now()-old.fetchedAt;
    if (old && age>=0 && age<ttl) return {...old.payload,cached:true};
    if (pending.has(key)) return pending.get(key);
    const work=(async()=>{
      try {
        const payload={...await load(),fetchedAt:now(),stale:false,cached:false};
        const entry={payload,fetchedAt:payload.fetchedAt,expiresAt:payload.fetchedAt+MAX_AGE};memory.set(key,entry);
        try { await options.set?.('searchCache',key,entry); } catch (_) {}
        return payload;
      } catch (error) {
        if (old && age>=0 && age<MAX_AGE) return {...old.payload,stale:true,cached:true,hint:'数据源暂不可用，显示缓存快照'};
        throw error;
      } finally {pending.delete(key);}
    })();
    pending.set(key,work);return work;
  }
  async function directory(type) {
    const url=type==='industry'?'https://vip.stock.finance.sina.com.cn/q/view/newSinaHy.php':'https://money.finance.sina.com.cn/q/view/newFLJK.php?param=class';
    return cached('directory-'+type,300000,async()=>({items:parseSectors(await request(url,5000),type),source:'sina',sourceTime:null}));
  }
  async function handle(event={}) {
    const mode=event.mode;
    if (!['indices','sectors','members','ranking','flowRanking','flow','orderbook'].includes(mode)) throw Error('不支持的发现功能');
    if (mode==='indices') return {ok:true,mode,...await cached('indices',30000,async()=>({items:parseIndices(await request('https://qt.gtimg.cn/q='+INDEX_DEFINITIONS.map(d=>d.code).join(','),5000),now()),source:'tencent',sourceTime:null}))};
    if (mode==='flow' || mode==='orderbook') {
      // Canonical prevalidation prevents provider requests for unsupported IDs even if resolve is permissive.
      const base=instruments.canonical(event.assetId);
      if (base.kind!=='stock' || !['SH','SZ'].includes(base.market)) throw Error('该功能仅支持沪深 A 股股票');
      const asset=await resolve(event.assetId);
      if (asset.id!==base.id || asset.kind!=='stock' || !['SH','SZ'].includes(asset.market)) throw Error('证券身份未确认');
      const payload=await cached(mode+'-'+asset.id,15000,async()=>{
        if (mode==='orderbook') return parseOrderbook(await request('https://qt.gtimg.cn/q='+asset.quoteCode,5000),asset,now());
        const secid=(asset.market==='SH'?'1.':'0.')+asset.code;
        const url='https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids='+secid+'&fields=f12,f13,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f124,f6&ut=b2884a393a59ad64002292a3e90d46a5';
        const row=parseFlowRows(await request(url,5000),now()).find(r=>r.assetId===asset.id);
        if (!row) throw Error('该股资金拆分暂不可用');
        return {...row,source:'eastmoney',scope:'东方财富按成交单大小估算，不代表机构身份或北向资金'};
      });
      return {ok:true,mode,...payload};
    }
    const page=validatePage(event.page);
    if (mode==='sectors') {
      const type=event.type || 'industry',sort=event.sort || 'changeDesc',keyword=event.keyword || '';
      if (!['industry','concept'].includes(type) || !SECTOR_SORTS.includes(sort) || typeof keyword!=='string' || keyword.length>40) throw Error('板块搜索或排序参数无效');
      const result=await directory(type),needle=keyword.trim().toLowerCase();
      const rows=result.items.filter(r=>(r.name+' '+r.node).toLowerCase().includes(needle)).slice();
      rows.sort((a,b)=>sort==='name'?a.name.localeCompare(b.name,'zh-CN'):
        sort==='changeAsc'?(a.changePct===null?Infinity:a.changePct)-(b.changePct===null?Infinity:b.changePct):
        (b[sort==='amountDesc'?'amount':'changePct']??-Infinity)-(a[sort==='amountDesc'?'amount':'changePct']??-Infinity));
      return {ok:true,mode,...result,items:rows.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE),page,hasMore:page<MAX_PAGE && rows.length>page*PAGE_SIZE,total:rows.length,
        scope:'新浪板块口径可能包含非 A 股，行业与概念并非互斥分类，不可加总'};
    }
    let node='hs_a';
    if (mode==='members') {
      const match=/^sina:(industry|concept):((?:new_|gn_)[A-Za-z0-9_]+)$/.exec(event.sectorId || '');
      if (!match) throw Error('请选择有效来源板块');
      const dir=await directory(match[1]);
      if (!dir.items.some(row=>row.id===event.sectorId)) throw Error('板块不在已验证目录中');
      node=match[2];
    }
    const sort=event.sort || (mode==='flowRanking'?'netInflow':'gainers');
    if (mode==='flowRanking' ? sort!=='netInflow' : !Object.prototype.hasOwnProperty.call(SORTS,sort)) throw Error('不支持的榜单排序');
    return {ok:true,mode,page,...await cached(mode+'-'+node+'-'+sort+'-'+page,30000,async()=>{
      let items,rawCount,source,scope;
      if (mode==='flowRanking') {
        const url='https://push2.eastmoney.com/api/qt/clist/get?pn='+page+'&pz='+PAGE_SIZE+'&po=1&np=1&fltt=2&fid=f62&fs=m:1+t:2,m:0+t:6,m:0+t:80&fields=f12,f13,f14,f62,f184,f66,f69,f72,f75,f78,f81,f84,f87,f124';
        const raw=await request(url,5000);items=parseFlowRows(raw,now());rawCount=json(raw).data.diff.length;source='eastmoney';
        scope='东方财富估算净流入，仅验证沪深主板/创业板口径；不代表机构或北向资金';
      } else {
        const [field,asc]=SORTS[sort];
        const url='https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page='+page+'&num='+PAGE_SIZE+'&sort='+field+'&asc='+asc+'&node='+node+'&symbol=';
        const raw=await request(url,5000);items=parseStockRows(raw);rawCount=json(raw).length;source='sina';
        scope=mode==='members'?'仅列本应用可核验的 A 股成员；供应商成员数可能包含其他证券，不能承诺完整覆盖':'新浪 hs_a 排名，包含已核验沪深北 A 股；时刻无源日期，仅展示获取时间';
      }
      // A non-empty but wholly invalid payload is an adapter failure, not a genuine empty page.
      if (rawCount && !items.length) throw Error('榜单证券身份或数据未通过校验');
      return {items,hasMore:page<MAX_PAGE && rawCount===PAGE_SIZE,source,sourceTime:mode==='flowRanking' && items.length?Math.max(...items.map(r=>r.sourceTime)):null,scope};
    })};
  }
  return {handle};
}
module.exports={INDEX_DEFINITIONS,PAGE_SIZE,MAX_PAGE,parseIndices,parseSectors,parseStockRows,parseFlowRows,parseOrderbook,createDiscovery};
