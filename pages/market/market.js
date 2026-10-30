const discovery=require('../../utils/discovery-client');
const portfolio=require('../../utils/portfolio-client');
const theme=require('../../utils/theme');
const display=require('../../utils/display-preferences');
const fmt=require('../../utils/asset-format');
const INDEX_KEY='discovery-indices-v1';
const INDEX_OPTIONS=[['sh000001','上证指数'],['sz399001','深证成指'],['sz399006','创业板指'],['sh000688','科创50'],['bj899050','北证50'],['hkHSI','恒生指数'],['us.IXIC','纳斯达克综合'],['us.INX','标普500']].map(([code,name])=>({id:'index:'+code,name}));
const DEFAULT_INDICES=INDEX_OPTIONS.slice(0,5).map(i=>i.id);
function amount(value){if(value==null || !Number.isFinite(Number(value)))return '--';const n=Number(value);return Math.abs(n)>=1e8?fmt.number(n/1e8)+' 亿元':Math.abs(n)>=1e4?fmt.number(n/1e4)+' 万元':fmt.number(n)+' 元';}
const SECTIONS={ranking:'A 股榜单',industry:'行业',concept:'概念',flowRanking:'资金净流入'};
Page({
 data:{theme:theme.getTheme(),quiet:false,section:'ranking',sections:Object.entries(SECTIONS).map(([value,label])=>({value,label})),
  indices:[],allIndices:[],indexError:'',indexLoading:false,indexNotice:'',indexEditing:false,indexOptions:[],indexDraft:[],indexIds:[],
  rows:[],listLoading:false,listError:'',listTime:'',listTitle:'A 股涨幅榜',scope:'',listPage:1,page:1,hasMore:false,
  sort:'gainers',rankSorts:[{value:'gainers',label:'涨幅'},{value:'losers',label:'跌幅'},{value:'amount',label:'成交额'}],
  sectorSort:'changeDesc',sectorSortIndex:0,sectorSortLabels:['涨幅优先','跌幅优先','成交额优先','名称'],keyword:'',searchKeyword:'',
  selectedSector:null,isSector:false,isFlow:false,followingIds:[],followingMap:{},rowBusy:'',rowError:'',rowErrorId:'',
 },
 onLoad(){
  this._alive=true;this._visible=false;this.setData({theme:theme.getTheme(),quiet:display.get().quiet});theme.applyChrome(this.data.theme);
  let ids=DEFAULT_INDICES.slice();try{const saved=wx.getStorageSync(INDEX_KEY);if(Array.isArray(saved))ids=saved.filter(id=>INDEX_OPTIONS.some(i=>i.id===id));}catch(_){}
  this.setData({indexIds:[...new Set(ids)]});this.updateIndexOptions();this.updateIndices();
 },
 async onShow(){
  this._visible=true;this.setData({theme:theme.getTheme(),quiet:display.get().quiet});theme.applyChrome(this.data.theme);
  await Promise.all([this.loadIndices(),this.loadList(),this.loadFollowing()]);
 },
 onHide(){this._visible=false;this._indexRequest=(this._indexRequest||0)+1;this._listRequest=(this._listRequest||0)+1;this._followingRequest=(this._followingRequest||0)+1;this._addRequest=(this._addRequest||0)+1;this.setData({indexLoading:false,listLoading:false,rowBusy:''});},
 onUnload(){this.onHide();this._alive=false;},
 active(request,key){return this._alive && this._visible && request===this[key];},
 updateIndexOptions(){this.setData({indexOptions:INDEX_OPTIONS.map(i=>({...i,checked:this.data.indexIds.includes(i.id)})),indexDraft:this.data.indexIds.slice()});},
 updateIndices(){this.setData({indices:INDEX_OPTIONS.filter(i=>this.data.indexIds.includes(i.id)).map(i=>this.data.allIndices.find(row=>row.id===i.id) || {...i,priceText:'--',pctText:'--',cls:'flat',timeText:'来源时间未确认',statusText:'暂不可用'})});},
 toggleIndexEditor(){this.updateIndexOptions();this.setData({indexEditing:!this.data.indexEditing,indexNotice:''});},
 onIndexChoice(e){this.setData({indexDraft:[...new Set((e.detail.value||[]).filter(id=>INDEX_OPTIONS.some(i=>i.id===id)))]});},
 saveIndexChoices(){
  const ids=this.data.indexDraft.slice();let notice='关注指数已保存到本设备';
  try{wx.setStorageSync(INDEX_KEY,ids);}catch(_){notice='本次选择已生效，设备保存失败，重新进入可能恢复原选择';}
  this.setData({indexIds:ids,indexEditing:false,indexNotice:notice});this.updateIndices();
 },
 async loadIndices(){
  if(!this._alive || !this._visible)return;const n=this._indexRequest=(this._indexRequest||0)+1;this.setData({indexLoading:true,indexError:''});
  try{
   const result=await discovery.indices();if(!this.active(n,'_indexRequest'))return;
   const rows=(result.items||[]).map(row=>({...row,priceText:fmt.number(row.price),pctText:row.changePct==null?'--':fmt.signed(row.changePct)+'%',cls:row.changePct>0?'up':row.changePct<0?'down':'flat',
    timeText:(row.sourceLabel||'来源时间未确认')+' '+(row.market==='US'?'纽约时间':row.market==='HK'?'香港时间':'北京时间'),
    statusText:result.stale?'缓存快照':row.status==='delayed'?'延迟快照':'来源快照'}));
   this.setData({allIndices:rows,indexError:result.stale?'指数源暂不可用，保留缓存；可重试':'',indexNotice:fmt.sourceName(result.source)+' · 获取时间 '+fmt.time(result.fetchedAt)});this.updateIndices();
  }catch(error){if(this.active(n,'_indexRequest'))this.setData({indexError:error.message||'指数暂不可用'});}
  finally{if(this.active(n,'_indexRequest'))this.setData({indexLoading:false});}
 },
 async loadFollowing(){
  const n=this._followingRequest=(this._followingRequest||0)+1;
  try{const state=await portfolio.list();if(this.active(n,'_followingRequest') && !state.offline)this.setData({followingIds:(state.items||[]).map(i=>i.id),followingMap:Object.fromEntries((state.items||[]).map(i=>[i.id,true]))});}catch(_){}
 },
 async loadList(){
  if(!this._alive || !this._visible)return;const n=this._listRequest=(this._listRequest||0)+1;
  const {section,selectedSector,page,sort,searchKeyword:keyword,sectorSort}=this.data;
  const isSector=!selectedSector && ['industry','concept'].includes(section),isFlow=section==='flowRanking';
  const title=selectedSector?selectedSector.name+' · A 股成员':section==='ranking'?'A 股'+({gainers:'涨幅',losers:'跌幅',amount:'成交额'})[sort]+'榜':isFlow?'资金净流入榜':SECTIONS[section]+' · 新浪口径';
  const queryKey=JSON.stringify([section,selectedSector?.id,page,sort,keyword,sectorSort]);
  const changed=queryKey!==this._listQueryKey;this._listQueryKey=queryKey;
  this.setData({listLoading:true,listError:'',rowError:'',rowErrorId:'',isSector,isFlow,listTitle:title,
   ...(changed?{rows:[],listTime:'',scope:'',hasMore:false,listPage:page}:{})});
  try{
   let result;
   if(selectedSector){result=await discovery.members(selectedSector.id,{page,sort});}
   else if(section==='ranking'){result=await discovery.ranking(sort,page);}
   else if(section==='flowRanking'){result=await discovery.flowRanking(page);}
   else{result=await discovery.sectors({type:section,keyword,sort:sectorSort,page});}
   if(!this.active(n,'_listRequest'))return;
   const resultPage=result.page||page;
   const rows=(result.items||[]).map((row,index)=>({...row,key:row.id||row.assetId,rank:(resultPage-1)*20+index+1,priceText:fmt.number(row.price,row.asset?.precision??2),pctText:row.changePct==null?'--':fmt.signed(row.changePct)+'%',
    amountText:amount(row.amount),flowText:amount(row.flow?.main),sourceTimeText:row.sourceTime?fmt.time(row.sourceTime):'',cls:(isFlow?row.flow?.main:row.changePct)>0?'up':(isFlow?row.flow?.main:row.changePct)<0?'down':'flat',
    canAdd:!!row.assetId && (row.price>0 || !!row.flow)}));
   this.setData({rows,isSector,isFlow,listPage:resultPage,hasMore:resultPage<10 && !!result.hasMore,listTitle:title,scope:result.scope||'',
    listTime:fmt.sourceName(result.source)+' · '+(result.stale?'缓存快照 · ':'')+(result.sourceTime?'行情来源 '+fmt.time(result.sourceTime)+' · ':'')+'获取时间 '+fmt.time(result.fetchedAt),
    listError:result.stale?'数据源暂不可用，显示缓存快照；可重试':''});
  }catch(error){if(this.active(n,'_listRequest'))this.setData({listError:(error.message||'榜单暂不可用')+(this.data.rows.length?'；保留上次列表':'' )});}
  finally{if(this.active(n,'_listRequest'))this.setData({listLoading:false});}
 },
 switchSection(e){const section=e.currentTarget.dataset.value;if(!Object.prototype.hasOwnProperty.call(SECTIONS,section))return;
  this.setData({section,selectedSector:null,page:1,keyword:'',searchKeyword:'',sort:'gainers'});return this.loadList();},
 selectSort(e){const sort=e.currentTarget.dataset.value;if(!['gainers','losers','amount'].includes(sort))return;this.setData({sort,page:1});return this.loadList();},
 onSectorSort(e){const i=Number(e.detail.value);const sort=['changeDesc','changeAsc','amountDesc','name'][i];if(!sort)return;this.setData({sectorSort:sort,sectorSortIndex:i,page:1});return this.loadList();},
 onKeywordInput(e){this.setData({keyword:e.detail.value});},
 searchSectors(){const keyword=this.data.keyword.trim();this.setData({page:1,keyword,searchKeyword:keyword});return this.loadList();},
 clearSearch(){this.setData({keyword:'',searchKeyword:'',page:1});return this.loadList();},
 openSector(e){const {id,name}=e.currentTarget.dataset;if(!this.data.rows.some(r=>r.id===id))return;this.setData({selectedSector:{id,name},page:1,sort:'gainers'});return this.loadList();},
 closeSector(){this.setData({selectedSector:null,page:1});return this.loadList();},
 nextPage(){if(this.data.listLoading || !this.data.hasMore || this.data.listPage>=10)return;this.setData({page:this.data.listPage+1});return this.loadList();},
 previousPage(){if(this.data.listLoading || this.data.listPage<=1)return;this.setData({page:this.data.listPage-1});return this.loadList();},
 openAsset(e){const id=e.currentTarget.dataset.id;if(!this.data.rows.some(r=>r.assetId===id))return;wx.navigateTo({url:'/pages/detail/detail?assetId='+encodeURIComponent(id)});},
 async addAsset(e){
  const id=e.currentTarget.dataset.id;if(this.data.rowBusy || this.data.followingIds.includes(id) || !this.data.rows.some(r=>r.assetId===id && r.canAdd))return;
  const n=this._addRequest=(this._addRequest||0)+1;this._followingRequest=(this._followingRequest||0)+1;
  this.setData({rowBusy:id,rowError:'',rowErrorId:''});
  try{const state=await portfolio.add(id);if(!this.active(n,'_addRequest'))return;this.setData({followingIds:(state.items||[]).map(i=>i.id),followingMap:Object.fromEntries((state.items||[]).map(i=>[i.id,true]))});}
  catch(error){if(this.active(n,'_addRequest'))this.setData({rowErrorId:id,rowError:error.message||'加入自选失败，请重试'});}
  finally{if(this.active(n,'_addRequest'))this.setData({rowBusy:''});}
 },
 onPullDownRefresh(){return Promise.all([this.loadIndices(),this.loadList(),this.loadFollowing()]).finally(()=>wx.stopPullDownRefresh());},
});
