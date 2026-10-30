const {inspectDraft}=require('../../utils/holdings-form');
const ledger=require('../../utils/ledger-client');
const portfolio=require('../../utils/portfolio-client');
const market=require('../../utils/market-client');
const theme=require('../../utils/theme');
const display=require('../../utils/display-preferences');
const TYPES=[{value:'openingPosition',label:'已有持仓'},{value:'buy',label:'买入'},{value:'sell',label:'卖出'},{value:'openingCash',label:'期初现金'},{value:'deposit',label:'转入'},{value:'withdrawal',label:'转出'},{value:'income',label:'分红收入'},{value:'expense',label:'独立费用'},{value:'split',label:'拆股 / 合股'}];
const TRADE_TYPES=['buy','sell','openingPosition'];
const CASH_TYPES=['openingCash','deposit','withdrawal'];
const LABELS=Object.fromEntries(TYPES.map(t=>[t.value,t.label]));
const MONEY_KEYS=['price','cost','averageCost','marketValue','realized','unrealized','totalPnl','daily'];
function number(value,digits=2){return value==null||!Number.isFinite(value)?'—':value.toLocaleString('en-US',{minimumFractionDigits:digits,maximumFractionDigits:digits});}
function today(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;}
function assetToday(asset){try{return asset&&asset.timezone?new Intl.DateTimeFormat('en-CA',{timeZone:asset.timezone,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()):today();}catch(_){return today();}}
function modal(options){return new Promise(resolve=>wx.showModal({...options,success:r=>resolve(!!r.confirm),fail:()=>resolve(false)}));}
Page({
 data:{view:'overview',viewTitle:'我的持仓',hasEntryDraft:false,advancedExpanded:false,assetSearchOpen:true,formTypes:[],availableQuantityText:'',canFillAll:false,positionFiltersExpanded:false,historyFiltersExpanded:false,refreshing:false,successText:'',positionQuery:'',historyQuery:'',historyTypeIndex:0,historyTypes:[{value:'',label:'全部类型'},...TYPES],expandedAssetId:'',overviewExpanded:false,positionCount:0,historyCount:0,formErrors:{},entryPreview:null,formSubmitted:false,searchDone:false,theme:theme.getTheme(),preferences:display.get(),loading:true,busy:false,loaded:false,errorText:'',offline:false,conflict:false,explanationsExpanded:false,currency:'CNY',currencyOptions:['CNY','HKD','USD'],sortIndex:0,sortOptions:['市值从高到低','浮动盈亏从高到低','浮动收益率从高到低','已实现收益率从高到低','名称'],showClosed:false,rows:[],historyRows:[],summary:{},revision:0,auditCount:0,operationCount:0,editing:false,grossWarning:'',draft:{},editId:'',types:TYPES,typeIndex:0,requiresAsset:true,isTrade:false,isOpening:true,isCash:false,isSplit:false,selectedAsset:null,keyword:'',searchResults:[],watchlist:[],quickAssets:[],searchBusy:false,noteEditing:false,noteConflict:false,noteAssetId:'',noteDraft:'',backupText:'',importPreview:null,exportReady:false},
 onLoad(){this._alive=true;this._request=0;this.setData({theme:theme.getTheme()});theme.applyChrome(this.data.theme);},
 async onShow(){this._visible=true;this._alive=true;this.setData({theme:theme.getTheme(),preferences:display.get(),searchBusy:false});this.render();theme.applyChrome(this.data.theme);return this.reload();},
 onHide(){this.setData({refreshing:false});this._visible=false;this._request++;this._assetEpoch=(this._assetEpoch||0)+1;},
 onUnload(){this._alive=false;this.onHide();},
 async onPullDownRefresh(){try{await this.reload();}finally{if(wx.stopPullDownRefresh)wx.stopPullDownRefresh();}},
 async reload(){
  if(this.data.refreshing)return;const request=++this._request;this.setData({loading:!this.data.loaded,refreshing:true});
  try{const r=await ledger.list();if(!this._alive||request!==this._request)return;this.applySnapshot(r);this.setData({loading:false,offline:false,errorText:''});}
  catch(e){if(this._alive&&request===this._request)this.setData({loading:false,offline:true,errorText:e.hint||e.message||'台账暂不可用'});}
  finally{if(this._alive&&request===this._request)this.setData({refreshing:false});}
 },
 applySnapshot(r){if(this._snapshot&&r.revision<this._snapshot.revision)return;this._snapshot=r;this.setData({revision:r.revision,loaded:true,auditCount:r.auditCount||0,operationCount:r.operationCount||0,quoteWarning:r.quoteWarning||''});this.render();},
 amount(value,digits=2){return this.data.preferences.hideAmounts?'••••':number(value,digits);},
 render(){
  const r=this._snapshot;if(!r)return;const c=r.currencies.find(c=>c.currency===this.data.currency);
  const summary=c?{currency:c.currency,cashText:c.cashTracked?this.amount(c.cash):'未设置',equityText:this.amount(c.equity),valueText:this.amount(c.marketValue),knownValueText:this.amount(c.knownValue),unrealizedText:this.amount(c.unrealized),realizedText:this.amount(c.realized),totalText:this.amount(c.totalPnl),rateText:this.data.preferences.hideAmounts?'••••':c.totalPnlRate==null?'—':number(c.totalPnlRate)+'%',floatRateText:this.data.preferences.hideAmounts?'••••':c.unrealizedRate==null?'—':number(c.unrealizedRate)+'%',allocationText:this.data.preferences.hideAmounts?'••••':c.allocation==null?'—':number(c.allocation)+'%',complete:c.complete,cashTracked:c.cashTracked,coverage:`${c.valuedCount||0}/${c.positionCount||0}`,days:(c.dailyGroups||[]).map(d=>({date:d.date,valueText:this.amount(d.value),complete:d.complete}))}:{currency:this.data.currency,cashText:'未设置',equityText:'—',valueText:'—',knownValueText:'—',unrealizedText:'—',realizedText:'—',totalText:'—',rateText:'—',floatRateText:'—',allocationText:'—',complete:true,cashTracked:false,coverage:'0/0',days:[]};
  let ps=r.positions.filter(p=>p.currency===this.data.currency&&(this.data.showClosed||p.quantity>0));
  const positionCount=ps.length,query=this.data.positionQuery.trim().toLowerCase();
  if(query)ps=ps.filter(p=>[p.name,p.code,p.assetId].some(v=>String(v||'').toLowerCase().includes(query)));
  const sortKey=['marketValue','unrealized','unrealizedRate','realizedRate'][this.data.sortIndex];
  ps.sort((a,b)=>!sortKey?a.name.localeCompare(b.name,'zh'):a[sortKey]==null?(b[sortKey]==null?0:1):b[sortKey]==null?-1:b[sortKey]-a[sortKey]);
  const rows=ps.map(p=>{const row={expanded:this.data.expandedAssetId===p.assetId,assetId:p.assetId,name:p.name,code:p.code,market:p.market,currency:p.currency,unit:p.unit,quantityText:number(p.quantity,6).replace(/\.?0+$/,'')||'0',note:p.note,closed:p.quantity===0,sessionDate:p.sessionDate||'交易日未知',dailyReason:p.dailyReason||'',source:p.source||'行情缺失',stale:p.stale,status:p.status,sourceTimeText:p.sourceTime?new Date(p.sourceTime).toLocaleString('zh-CN'):'时间未知',gainClass:this.data.preferences.quiet?'neutral':p.unrealized>0?'up':p.unrealized<0?'down':'neutral',realizedRateText:this.data.preferences.hideAmounts?'••••':p.realizedRate==null?'—':number(p.realizedRate)+'%',rateText:this.data.preferences.hideAmounts?'••••':p.unrealizedRate==null?'—':number(p.unrealizedRate)+'%',totalRateText:this.data.preferences.hideAmounts?'••••':p.totalPnlRate==null?'—':number(p.totalPnlRate)+'%'};for(const key of MONEY_KEYS)row[key+'Text']=this.amount(p[key],key==='price'||key==='averageCost'?4:2);row.valueText=row.marketValueText;return row;});
  const historyEntries=(r.entries||[]).filter(e=>e.currency===this.data.currency),historyCount=historyEntries.length,historyQuery=this.data.historyQuery.trim().toLowerCase(),historyType=this.data.historyTypes[this.data.historyTypeIndex].value;
  const historyRows=historyEntries.filter(e=>{const a=r.assets.find(a=>a.id===e.assetId)||{};return (!historyType||e.type===historyType)&&(!historyQuery||[a.name,a.code,e.assetId].some(v=>String(v||'').toLowerCase().includes(historyQuery)));}).slice().reverse().map(e=>({logicalId:e.logicalId,name:(r.assets.find(a=>a.id===e.assetId)||{}).name||e.currency,typeText:LABELS[e.type]||e.type,date:e.date,sequence:e.sequence,version:e.version,quantityText:e.quantity||'',amountText:this.data.preferences.hideAmounts?'••••':e.type==='split'?`${e.denominator} → ${e.numerator}`:e.amount!=null?e.amount:e.cost!=null?e.cost:e.grossAmount||'—',feeText:this.data.preferences.hideAmounts?'••••':e.fee||'0',note:e.note||''}));
  const privacyPatch=this.data.preferences.hideAmounts&&this.data.importPreview?{importPreview:{...this.data.importPreview,currencies:this.data.importPreview.currencies.map(c=>({...c,cashText:'••••',valueText:'••••'}))}}:{};
  summary.primaryLabel=c&&c.cashTracked?'总资产':'持仓市值';
  summary.primaryText=c?this.amount(c.cashTracked?c.equity:c.marketValue):this.amount(0);
  summary.hasPositions=r.positions.some(p=>p.currency===this.data.currency);
  if(!c&&!summary.hasPositions)summary.unrealizedText=this.amount(0);
  summary.gainClass=this.data.preferences.quiet?'neutral':c&&c.unrealized>0?'up':c&&c.unrealized<0?'down':'neutral';
  this.setData({summary,rows,historyRows,positionCount,historyCount,hasCurrencyPositions:summary.hasPositions,...privacyPatch});
 },
 inputPositionQuery(e){this.setData({positionQuery:e.detail.value});this.render();},
 clearPositionQuery(){this.setData({positionQuery:''});this.render();},
 inputHistoryQuery(e){this.setData({historyQuery:e.detail.value});this.render();},
 changeHistoryType(e){this.setData({historyTypeIndex:Number(e.detail.value)});this.render();},
 clearHistoryFilters(){this.setData({historyQuery:'',historyTypeIndex:0});this.render();},
 toggleOverview(){this.setData({overviewExpanded:!this.data.overviewExpanded});},
 togglePosition(e){const id=e.currentTarget.dataset.id;this.setData({expandedAssetId:this.data.expandedAssetId===id?'':id});this.render();},
 updateForm(){
  const r=inspectDraft(this.data.draft),p=this._snapshot&&this._snapshot.positions.find(p=>p.assetId===this.data.draft.assetId);
  this.setData({entryPreview:r.preview,formErrors:this.data.formSubmitted?r.errors:{},availableQuantityText:p?number(p.quantity,6).replace(/\.?0+$/,''):'',canFillAll:!!(p&&p.quantity>0&&this.data.draft.type==='sell'&&!this.data.editId&&this.data.draft.date===assetToday(this.data.selectedAsset))});
 },
 setView(view,patch={},done){const titles={overview:'我的持仓',entry:'记一笔',history:'交易记录',note:'持仓备注',backup:'备份与恢复',help:'计算说明'};this.setData({view,viewTitle:titles[view]||'我的持仓',editing:view==='entry',noteEditing:view==='note',...patch},done||(()=>{if(wx.pageScrollTo)wx.pageScrollTo({scrollTop:0,duration:0});}));},
 backToHoldings(){if(this.data.busy)return;this.setView('overview',{errorText:this.data.offline?this.data.errorText:'',successText:''});},
 togglePositionFilters(){this.setData({positionFiltersExpanded:!this.data.positionFiltersExpanded});},
 toggleHistoryFilters(){this.setData({historyFiltersExpanded:!this.data.historyFiltersExpanded});},
 toggleAdvanced(){this.setData({advancedExpanded:!this.data.advancedExpanded});},
 changeAsset(){if(!this.data.busy)this.setData({assetSearchOpen:true});},
 fillAllQuantity(){if(!this.data.canFillAll||this.data.busy)return;const p=this._snapshot.positions.find(p=>p.assetId===this.data.draft.assetId);if(p)this.inputDraft({currentTarget:{dataset:{key:'quantity'}},detail:{value:String(p.quantity)}});},
 showMore(){if(this.data.busy)return;const actions=[()=>this.setView('history'),()=>this.manageCash(),()=>this.toggleOverview(),()=>this.showOtherEntries(),()=>this.setView('backup'),()=>this.setView('help')];wx.showActionSheet({itemList:['交易记录','现金管理','资产明细','其他记账','备份与恢复','计算说明'],success:r=>{if(this._alive&&this._visible&&actions[r.tapIndex])actions[r.tapIndex]();}});},
 showOtherEntries(){wx.showActionSheet({itemList:['分红收入','独立费用','拆股合股'],success:r=>{if(this._alive&&this._visible)this.openEntry({currentTarget:{dataset:{type:['income','expense','split'][r.tapIndex]}}});}});},
 showPositionMore(e){const id=e.currentTarget.dataset.id;wx.showActionSheet({itemList:['分红收入','拆股合股','编辑备注','加入自选','查看行情'],success:r=>{if(!this._alive||!this._visible)return;const event={currentTarget:{dataset:{id}}};if(r.tapIndex<2)this.openEntry({currentTarget:{dataset:{id,type:r.tapIndex===0?'income':'split'}}});else if(r.tapIndex===2)this.openNote(event);else if(r.tapIndex===3)this.follow(event);else this.openDetail(event);}});},
 async startEntry(){if(this.data.busy||!this.data.loaded)return;if(this.data.hasEntryDraft){this.resumeEntry();return;}return this.openEntry({currentTarget:{dataset:{type:this.data.hasCurrencyPositions?'buy':'openingPosition'}}});},
 async manageCash(){if(this.data.busy||!this.data.loaded)return;const c=this._snapshot.currencies.find(c=>c.currency===this.data.currency);return this.openEntry({currentTarget:{dataset:{type:c&&c.cashTracked?'deposit':'openingCash'}}});} ,
 toggleExplanations(){this.setData({explanationsExpanded:!this.data.explanationsExpanded});},
 chooseCurrency(e){const currency=e.currentTarget.dataset.currency||this.data.currencyOptions[Number(e.detail.value)];if(!currency)return;this.setData({currency});this.render();},
 changeSort(e){this.setData({sortIndex:Number(e.detail.value)});this.render();},
 toggleClosed(e){this.setData({showClosed:!!e.detail.value});this.render();},
 resumeEntry(){if(this.data.hasEntryDraft&&!this.data.busy){this.setView('entry');this.formType(this.data.draft.type);}},
 async openEntry(e){
  if(this.data.busy)return;const ds=e&&e.currentTarget&&e.currentTarget.dataset||{},type=ds.type||'openingPosition',assetId=ds.id||'';
  if(this.data.hasEntryDraft){const replace=await modal({title:'开始新的一笔？',content:'当前页面有未保存的草稿，开始新的一笔会替换它。',confirmText:'替换草稿'});if(!replace||!this._alive||!this._visible)return;}
  this._entryReturnView=this.data.view==='history'?'history':'overview';
  this._assetEpoch=(this._assetEpoch||0)+1;this._draftRevision=this.data.revision;
  const selectedAsset=this._snapshot&&this._snapshot.assets.find(a=>a.id===assetId)||null;
  this.setView('entry',{hasEntryDraft:false,advancedExpanded:false,assetSearchOpen:!selectedAsset,formSubmitted:false,formErrors:{},entryPreview:null,successText:'',searchDone:false,noteEditing:false,editing:true,editId:'',draft:{type,date:assetToday(selectedAsset),currency:selectedAsset?selectedAsset.currency:this.data.currency,assetId,quantity:'',price:'',fee:'0',cost:'',amount:'',grossAmount:'',grossAmountMode:'auto',note:'',numerator:'2',denominator:'1'},selectedAsset,grossWarning:'',searchBusy:false,errorText:'',conflict:false,keyword:'',searchResults:[]});this._draftInitial=JSON.stringify(this.data.draft);this.formType(type);if(wx.pageScrollTo)wx.pageScrollTo({scrollTop:0,duration:0});
  if(!this.data.requiresAsset)return;
  // Suggestions are optional: opening a ledger form must not invoke portfolio's
  // remote metadata resolution. Selecting a suggestion still resolves its identity.
  let cached=null;try{cached=portfolio.getCached?portfolio.getCached():null;}catch(_){}
  const assets=Array.from(new Map([...(this._snapshot.assets||[]),...(cached&&Array.isArray(cached.items)?cached.items:[])].map(a=>[a.id,a])).values());
  this.setData({watchlist:assets,quickAssets:assets.slice(0,6)});
 },
 formType(type){const c=this._snapshot&&this._snapshot.currencies.find(c=>c.currency===this.data.draft.currency);const options=TRADE_TYPES.includes(type)?TRADE_TYPES:CASH_TYPES.includes(type)?CASH_TYPES.filter(t=>t!=='openingCash'||!c||!c.cashTracked||(this.data.editId&&this._snapshot.entries.some(e=>e.logicalId===this.data.editId&&e.type==='openingCash'))):[];this.setData({viewTitle:this.data.editId?'修改记录':LABELS[type],formTypes:options.map(v=>TYPES.find(t=>t.value===v)),typeIndex:TYPES.findIndex(t=>t.value===type),requiresAsset:['openingPosition','buy','sell','split','income'].includes(type),isTrade:['buy','sell'].includes(type),isOpening:type==='openingPosition',isCash:['openingCash','deposit','withdrawal','income','expense'].includes(type),isSplit:type==='split'});this.updateForm();},
 selectFormType(e){const type=e.currentTarget.dataset.type;if(this.data.formTypes.some(t=>t.value===type))this.switchDraftType(type);},
 switchDraftType(type){
  if(this.data.busy||type===this.data.draft.type)return;
  this._assetEpoch=(this._assetEpoch||0)+1;const needsAsset=['openingPosition','buy','sell','income','split'].includes(type),sameTrade=['buy','sell'].includes(type)&&['buy','sell'].includes(this.data.draft.type);
  this.setData({searchBusy:false,formSubmitted:false,formErrors:{},grossWarning:'',searchDone:false,searchResults:[],selectedAsset:needsAsset?this.data.selectedAsset:null,draft:{...this.data.draft,type,assetId:needsAsset?this.data.draft.assetId:'',quantity:sameTrade?this.data.draft.quantity:'',price:sameTrade?this.data.draft.price:'',fee:'0',cost:'',amount:'',grossAmount:'',grossAmountMode:'auto'}});this.formType(type);
 },
 inputDraft(e){const key=e.currentTarget.dataset.key;if(!['quantity','price','grossAmount','fee','cost','amount','date','note','numerator','denominator'].includes(key))return;this._assetEpoch=(this._assetEpoch||0)+1;const draft={...this.data.draft,[key]:e.detail.value};let grossWarning=this.data.grossWarning;
  if(['quantity','price'].includes(key)){if(this.data.draft.grossAmount&&(this.data.draft.grossAmountMode||'explicit')==='explicit')grossWarning='已清空原手工成交金额。请按新数量和单价重新填写实际金额，留空则自动计算数量 × 单价。';draft.grossAmount='';draft.grossAmountMode='auto';}
  if(key==='grossAmount'){draft.grossAmountMode=e.detail.value===''?'auto':'explicit';grossWarning=e.detail.value===''?'':'实际成交金额将作为成本与现金依据，单价和数量仅作记录，请核对三者。';}
  this.setData({draft,grossWarning,searchBusy:false});this.updateForm();},
 changeDraftCurrency(e){this.setData({draft:{...this.data.draft,currency:this.data.currencyOptions[Number(e.detail.value)]}});this.formType(this.data.draft.type);if(!this.data.editId&&this.data.draft.type==='openingCash'&&!this.data.formTypes.some(t=>t.value==='openingCash'))this.switchDraftType('deposit');},
 cancelEntry(){if(this.data.busy)return;this._assetEpoch=(this._assetEpoch||0)+1;this.setData({hasEntryDraft:JSON.stringify(this.data.draft)!==this._draftInitial,editing:false,searchBusy:false,errorText:''});this.setView(this._entryReturnView||'overview');},
 inputKeyword(e){this._assetEpoch=(this._assetEpoch||0)+1;this.setData({keyword:e.detail.value,searchResults:[],searchBusy:false,searchDone:false});},
 async searchAssets(){
  if(!this.data.keyword.trim())return;const request=this._assetEpoch=(this._assetEpoch||0)+1;this.setData({searchBusy:true,errorText:''});
  try{const r=await market.search(this.data.keyword.trim());if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({searchDone:true,searchResults:r.assets||r.items||[]});}catch(e){if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({errorText:e.message});}finally{if(this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch)this.setData({searchBusy:false});}
 },
 async selectAsset(e){
  const id=e.currentTarget.dataset.id,request=this._assetEpoch=(this._assetEpoch||0)+1;const active=()=>this._alive&&this._visible&&this.data.editing&&request===this._assetEpoch;this.setData({searchBusy:true,errorText:''});
  try{const r=await market.resolve(id);if(active()){this.setData({selectedAsset:r.asset,draft:{...this.data.draft,assetId:r.asset.id,currency:r.asset.currency,date:this.data.draft.date===today()?assetToday(r.asset):this.data.draft.date},keyword:'',searchResults:[],searchDone:false,assetSearchOpen:false});this.updateForm();}}catch(e){if(active())this.setData({errorText:e.message});}finally{if(active())this.setData({searchBusy:false});}
 },
 async saveEntry(){
  if(!this.data.editing||this.data.busy||this.data.searchBusy||this.data.conflict)return;const draft={...this.data.draft};
  this.setData({formSubmitted:true});const inspection=inspectDraft(draft);this.setData({formErrors:inspection.errors,entryPreview:inspection.preview});
  if(Object.keys(inspection.errors).length){this.setData({advancedExpanded:this.data.advancedExpanded||!!(inspection.errors.date||inspection.errors.grossAmount),errorText:'请检查标出的内容'});return;}
  this.setData({busy:true,errorText:'',conflict:false});
  try{const r=await ledger.saveEntry(draft,this._draftRevision==null?this.data.revision:this._draftRevision,this.data.editId||undefined);if(!this._alive)return;this.applySnapshot(r);this.setData({editing:false,hasEntryDraft:false,offline:false,successText:'流水已保存，持仓与现金已重算'});this.setView(this._entryReturnView||'overview');wx.showToast({title:'保存成功',icon:'success'});}
  catch(e){if(this._alive)this.setData({errorText:e.hint||e.message,conflict:e.code==='revision-conflict'});}finally{if(this._alive)this.setData({busy:false});}
 },
 async refreshDraftRevision(){if(this.data.refreshing||this.data.busy)return;await this.reload();if(!this.data.offline){this._draftRevision=this.data.revision;this.setData({conflict:false,errorText:'已载入最新台账；草稿保留，请核对后重新保存。'});}},
 async editEntry(e){
  if(this.data.busy)return;const entry=this._snapshot.entries.find(x=>x.logicalId===e.currentTarget.dataset.id);if(!entry)return;
  if(this.data.hasEntryDraft){const replace=await modal({title:'替换当前草稿？',content:'修改这笔历史流水会替换当前页面尚未保存的草稿。',confirmText:'替换草稿'});if(!replace||!this._alive||!this._visible)return;}
  this._assetEpoch=(this._assetEpoch||0)+1;this._draftRevision=this.data.revision;const draft={...entry};if(draft.grossAmountMode==='auto')draft.grossAmount='';this._entryReturnView='history';this.setView('entry',{hasEntryDraft:false,advancedExpanded:!!(draft.grossAmount||draft.note),assetSearchOpen:!entry.assetId,formSubmitted:false,formErrors:{},successText:'',noteEditing:false,editing:true,searchBusy:false,grossWarning:draft.grossAmount?'该笔使用手工成交金额作为成本与现金依据；修改数量或单价将清空此金额，请重新核对。':'',editId:entry.logicalId,draft,selectedAsset:this._snapshot.assets.find(a=>a.id===entry.assetId)||null,errorText:'',conflict:false,keyword:'',searchResults:[]});this._draftInitial=JSON.stringify(this.data.draft);this.formType(entry.type);if(wx.pageScrollTo)wx.pageScrollTo({scrollTop:0,duration:0});
 },
 async voidEntry(e){
  if(this.data.busy)return;const id=e.currentTarget.dataset.id;
  const confirmed=await modal({title:'撤销这笔流水？',content:'将重算之后全部持仓、现金与已实现盈亏。原记录保留审计；若造成历史超卖或现金不足，将拒绝整次撤销。',confirmText:'确认撤销',confirmColor:'#9a4b12'});if(!confirmed||!this._alive)return;
  this.setData({busy:true,errorText:''});try{const r=await ledger.voidEntry(id,this.data.revision);if(this._alive)this.applySnapshot(r);}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}
 },
 openNote(e){if(this.data.busy)return;const id=e.currentTarget.dataset.id;this._noteRevision=this.data.revision;this.setView('note',{noteAssetId:id,noteDraft:(this._snapshot.notes||{})[id]||'',noteConflict:false,errorText:''},()=>{if(wx.pageScrollTo)wx.pageScrollTo({selector:'#note-editor',duration:0});});},
 async refreshNoteRevision(){if(this.data.refreshing||this.data.busy)return;await this.reload();if(!this.data.offline){this._noteRevision=this.data.revision;this.setData({noteConflict:false,errorText:'已读取最新台账，备注草稿保留，请核对后保存。'});}},
 inputNote(e){this.setData({noteDraft:e.detail.value});},
 cancelNote(){if(!this.data.busy)this.setView('overview');},
 async saveNote(){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{const r=await ledger.saveNote(this.data.noteAssetId,this.data.noteDraft,this._noteRevision);if(this._alive){this.applySnapshot(r);this.setView('overview',{successText:'持仓备注已保存'});wx.showToast({title:'备注已保存',icon:'success'});}}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message,noteConflict:e.code==='revision-conflict'});}finally{if(this._alive)this.setData({busy:false});}},
 openDetail(e){wx.navigateTo({url:'/pages/detail/detail?assetId='+encodeURIComponent(e.currentTarget.dataset.id)});},
 async follow(e){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{await portfolio.add(e.currentTarget.dataset.id);wx.showToast({title:'已加入自选',icon:'success'});}catch(e){this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}},
 inputBackup(e){this._importBackup=null;this.setData({backupText:e.detail.value,importPreview:null,exportReady:false});},
 async generateBackup(){if(this.data.busy)return;this.setData({busy:true,errorText:''});try{const r=await ledger.exportBackup();if(this._alive)this.setData({backupText:JSON.stringify(r.backup,null,2),exportReady:true,importPreview:null});}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}},
 copyBackup(){if(!this.data.backupText)return;wx.setClipboardData({data:this.data.backupText,success:()=>wx.showToast({title:'备份已复制',icon:'success'})});},
 async chooseBackup(){
  if(this.data.busy||!wx.chooseMessageFile||!wx.getFileSystemManager){this.setData({errorText:'当前环境不支持文件选择，请将JSON内容粘贴到文本框'});return;}
  wx.chooseMessageFile({count:1,type:'file',extension:['json'],success:r=>{const file=r.tempFiles&&r.tempFiles[0];if(!file)return;if(file.size>512*1024){this.setData({errorText:'备份不能超过512KB'});return;}wx.getFileSystemManager().readFile({filePath:file.path,encoding:'utf8',success:x=>{if(this._alive){this._importBackup=null;this.setData({backupText:x.data,importPreview:null,exportReady:false,errorText:''});}},fail:()=>this.setData({errorText:'读取失败，请粘贴JSON内容'})});},fail:()=>{}});
 },
 async saveBackupFile(){
  if(!this.data.exportReady||!this.data.backupText)return;
  if(!wx.getFileSystemManager||!wx.env||!wx.env.USER_DATA_PATH){this.setData({errorText:'当前环境不支持保存文件，请复制备份'});return;}
  const filePath=wx.env.USER_DATA_PATH+'/holdings-backup-'+Date.now()+'.json';
  wx.getFileSystemManager().writeFile({filePath,data:this.data.backupText,encoding:'utf8',success:()=>{if(wx.shareFileMessage)wx.shareFileMessage({filePath,fileName:'holdings-backup.json',fail:()=>this.setData({errorText:'分享未完成，备份仍可复制'})});else this.setData({errorText:'备份文件已生成；当前环境不支持分享，请复制JSON保存'});},fail:()=>this.setData({errorText:'文件生成失败，请复制备份'})});
 },
 async previewImport(){
  if(this.data.busy)return;this.setData({busy:true,errorText:'',importPreview:null});
  try{const backup=JSON.parse(this.data.backupText);const r=await ledger.previewImport(backup,this.data.revision);if(!this._alive)return;this._importBackup=backup;this._importHash=r.previewHash;this._importRevision=r.revision;const hidden=this.data.preferences.hideAmounts;
   this.setData({importPreview:{previousCount:r.previousCount,entryCount:r.preview.entries.length,auditCount:r.preview.auditCount,assetCount:r.preview.assets.length,currencies:r.preview.currencies.map(c=>({currency:c.currency,cashText:hidden?'••••':number(c.cash),valueText:hidden?'••••':number(c.marketValue),complete:c.complete}))}});
  }catch(e){if(this._alive)this.setData({errorText:e.hint||e.message||'JSON格式无效'});}finally{if(this._alive)this.setData({busy:false});}
 },
 async confirmImport(){
  if(this.data.busy||!this.data.importPreview||!this._importBackup)return;
  const confirm=await modal({title:'恢复这份台账备份？',content:'将原子替换当前手工持仓、流水和持仓备注。请先导出当前台账留存。自选、提醒和会员权限不在恢复范围。',confirmText:'确认恢复'});if(!confirm||!this._alive)return;
  this.setData({busy:true,errorText:''});try{const r=await ledger.importBackup(this._importBackup,this._importRevision,this._importHash);if(this._alive){this.applySnapshot(r);this.setData({importPreview:null,backupText:'',exportReady:false});this._importBackup=null;}}catch(e){if(this._alive)this.setData({errorText:e.hint||e.message});}finally{if(this._alive)this.setData({busy:false});}
 }
});
